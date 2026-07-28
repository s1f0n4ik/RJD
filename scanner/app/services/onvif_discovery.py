"""
app/services/onvif_discovery.py

ONVIF WS-Discovery — поиск камер в локальной сети через multicast.
Камеры отвечают на probe-запрос, отправленный на 239.255.255.250:3702.

Не требует перебора всех IP — это broadcast-механизм самих устройств.
После обнаружения опционально вытягиваем имя/модель через ONVIF GetDeviceInformation.
"""

from __future__ import annotations

import asyncio
import logging
import socket
import struct
import uuid
import re
from dataclasses import dataclass, asdict
from typing import List, Optional
from xml.etree import ElementTree as ET

logger = logging.getLogger(__name__)

# Multicast-адрес WS-Discovery
WSD_MULTICAST_ADDR = "239.255.255.250"
WSD_PORT = 3702
WSD_TIMEOUT = 4.0  # секунды на сбор ответов


# Шаблон probe-сообщения. Ищем устройства типа NetworkVideoTransmitter (ONVIF-камеры).
def _build_probe() -> bytes:
    message_id = uuid.uuid4()
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
            xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:{message_id}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </e:Body>
</e:Envelope>"""
    return body.encode("utf-8")


@dataclass
class DiscoveredCamera:
    ip: str
    port: int
    xaddr: str                      # полный ONVIF service URL
    name: Optional[str] = None      # из Scopes (hardware/name) или GetDeviceInformation
    model: Optional[str] = None
    manufacturer: Optional[str] = None
    types: Optional[str] = None


def _extract_xaddrs(xml_text: str) -> List[str]:
    """Достаёт XAddrs (адреса ONVIF-сервисов) из ProbeMatch ответа."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    addrs: List[str] = []
    # XAddrs может быть в разных namespace, ищем по localname
    for elem in root.iter():
        if elem.tag.endswith("XAddrs") and elem.text:
            addrs.extend(elem.text.split())
    return addrs


def _extract_scopes(xml_text: str) -> List[str]:
    """Достаёт Scopes — там часто закодированы name/hardware/location."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    for elem in root.iter():
        if elem.tag.endswith("Scopes") and elem.text:
            return elem.text.split()
    return []


def _parse_scope_value(scopes: List[str], key: str) -> Optional[str]:
    """
    Scopes выглядят как onvif://www.onvif.org/name/MyCamera
    Вытаскиваем значение по ключу (name, hardware, location).
    """
    prefix = f"onvif://www.onvif.org/{key}/"
    for s in scopes:
        if s.startswith(prefix):
            val = s[len(prefix):]
            # URL-decode простых случаев
            return val.replace("%20", " ").replace("%2F", "/")
    return None


def _ip_from_xaddr(xaddr: str) -> tuple[str, int]:
    """
    http://192.168.1.10/onvif/device_service → (192.168.1.10, 80)
    IPv6-адреса (http://[fe80::...]/...) отбрасываем — возвращаем ("", 0).
    """
    # Явно отсекаем IPv6 в квадратных скобках
    if "[" in xaddr:
        return "", 0

    m = re.match(r"https?://([^:/]+)(?::(\d+))?", xaddr)
    if not m:
        return "", 0
    ip = m.group(1)

    # Проверяем что это валидный IPv4
    parts = ip.split(".")
    if len(parts) != 4 or not all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
        return "", 0

    port = int(m.group(2)) if m.group(2) else 80
    return ip, port


def _discover_sync(timeout: float, local_addrs: Optional[List[str]] = None) -> List[DiscoveredCamera]:
    """
    Синхронная реализация WS-Discovery на блокирующем сокете.
    Вызывается в executor'е — не зависит от реализации event-loop
    (uvloop не поддерживает loop.sock_sendto для датаграмм).

    local_addrs — адреса, с которых рассылать probe. На машине с несколькими
    подсетями без этого ядро выбирает один адрес по дефолтному маршруту,
    и камеры из остальных сетей probe не получают. Пусто — поведение ядра.
    """
    import time

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)

    try:
        # Приём со всех подсетей идёт в этот же сокет
        sock.bind(("", 0))
    except OSError as e:
        logger.error(f"WSD bind failed: {e}")
        sock.close()
        return []

    probe = _build_probe()
    send_from = list(local_addrs) if local_addrs else [None]

    # Отправляем probe несколько раз — UDP ненадёжен
    for _ in range(2):
        for addr in send_from:
            try:
                if addr:
                    # Задаёт и исходящий интерфейс, и адрес источника
                    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(addr))
                sock.sendto(probe, (WSD_MULTICAST_ADDR, WSD_PORT))
            except OSError as e:
                logger.warning(f"WSD send from {addr or 'default'} failed: {e}")
        time.sleep(0.1)

    found: dict[str, DiscoveredCamera] = {}
    deadline = time.monotonic() + timeout

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        sock.settimeout(remaining)
        try:
            data, _addr = sock.recvfrom(65535)
        except socket.timeout:
            break
        except OSError:
            break

        if not data:
            continue

        xml_text = data.decode("utf-8", errors="ignore")
        xaddrs = _extract_xaddrs(xml_text)
        scopes = _extract_scopes(xml_text)

        for xaddr in xaddrs:
            ip, port = _ip_from_xaddr(xaddr)
            if not ip or ip in found:
                continue

            name = _parse_scope_value(scopes, "name")
            hardware = _parse_scope_value(scopes, "hardware")

            found[ip] = DiscoveredCamera(
                ip=ip,
                port=port,
                xaddr=xaddr,
                name=name,
                model=hardware,
            )

    sock.close()
    logger.info(f"WSD discovery: found {len(found)} camera(s)")
    return list(found.values())


async def discover_cameras(
        timeout: float = WSD_TIMEOUT,
        local_addrs: Optional[List[str]] = None,
) -> List[DiscoveredCamera]:
    """
    Асинхронная обёртка: синхронный discovery выполняется в executor'е,
    чтобы не блокировать event-loop и не зависеть от uvloop.
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _discover_sync, timeout, local_addrs)


async def enrich_device_info(camera: DiscoveredCamera, username: str = "", password: str = "") -> DiscoveredCamera:
    """
    Опционально дёргает ONVIF GetDeviceInformation для уточнения модели/производителя.
    Требует библиотеку onvif-zeep. Если её нет или камера не отвечает — возвращаем как есть.
    """
    try:
        from onvif import ONVIFCamera  # onvif-zeep
    except ImportError:
        logger.debug("onvif-zeep not installed, skipping enrichment")
        return camera

    try:
        # ONVIFCamera блокирующий — выносим в executor
        loop = asyncio.get_event_loop()

        def _fetch():
            cam = ONVIFCamera(camera.ip, camera.port, username, password)
            info = cam.devicemgmt.GetDeviceInformation()
            return info

        info = await asyncio.wait_for(loop.run_in_executor(None, _fetch), timeout=5.0)
        camera.manufacturer = getattr(info, "Manufacturer", None)
        camera.model = getattr(info, "Model", None) or camera.model
        if not camera.name:
            camera.name = camera.model
    except Exception as e:
        logger.debug(f"enrich {camera.ip} failed: {e}")

    return camera


def camera_to_dict(c: DiscoveredCamera) -> dict:
    return asdict(c)