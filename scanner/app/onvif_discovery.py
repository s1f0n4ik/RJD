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
    """http://192.168.1.10/onvif/device_service → (192.168.1.10, 80)"""
    m = re.match(r"https?://([^:/]+)(?::(\d+))?", xaddr)
    if not m:
        return "", 0
    ip = m.group(1)
    port = int(m.group(2)) if m.group(2) else 80
    return ip, port


async def discover_cameras(timeout: float = WSD_TIMEOUT) -> List[DiscoveredCamera]:
    """
    Рассылает WS-Discovery probe и собирает ответы камер.
    Возвращает список уникальных по IP камер.
    """
    loop = asyncio.get_event_loop()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    sock.setblocking(False)

    try:
        sock.bind(("", 0))
    except OSError as e:
        logger.error(f"WSD bind failed: {e}")
        sock.close()
        return []

    probe = _build_probe()

    # Отправляем probe несколько раз — UDP ненадёжен
    for _ in range(2):
        try:
            await loop.sock_sendto(sock, probe, (WSD_MULTICAST_ADDR, WSD_PORT))
        except OSError as e:
            logger.warning(f"WSD send failed: {e}")
        await asyncio.sleep(0.1)

    found: dict[str, DiscoveredCamera] = {}
    deadline = loop.time() + timeout

    while loop.time() < deadline:
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        try:
            data = await asyncio.wait_for(loop.sock_recv(sock, 65535), timeout=remaining)
        except asyncio.TimeoutError:
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