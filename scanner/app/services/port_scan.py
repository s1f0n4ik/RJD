"""
app/services/port_scan.py

Активное сканирование сети на камеры по открытым портам (RTSP/HTTP).
Дополняет ONVIF-discovery: находит камеры, которые не отвечают на WS-Discovery
(старая прошивка, выключен ONVIF, и т.п.).

Сканирование идёт батчами по 25 адресов — чтобы UI мог обновляться по мере прогресса.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, asdict
from typing import AsyncGenerator, List, Optional

logger = logging.getLogger(__name__)

# Порты, по которым опознаём камеру
RTSP_PORT = 554
HTTP_PORTS = [80, 8000, 8080]

BATCH_SIZE = 25
CONNECT_TIMEOUT = 0.6  # сек на одно TCP-соединение


@dataclass
class LocalSubnet:
    prefix: str    # '192.168.1.'
    address: str   # адрес самой машины в этой подсети
    iface: str


@dataclass
class PortScanResult:
    ip: str
    open_ports: List[int]
    has_rtsp: bool
    vendor: Optional[str] = None   # из RTSP OPTIONS Server-заголовка, если удалось


async def _check_port(ip: str, port: int) -> bool:
    """Пытается открыть TCP-соединение. True если порт принимает подключения."""
    try:
        fut = asyncio.open_connection(ip, port)
        reader, writer = await asyncio.wait_for(fut, timeout=CONNECT_TIMEOUT)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return True
    except (asyncio.TimeoutError, OSError):
        return False


async def _probe_rtsp_vendor(ip: str, port: int = RTSP_PORT) -> Optional[str]:
    """
    Шлёт RTSP OPTIONS и пытается вытащить Server-заголовок.
    Многие камеры отвечают 'Server: Hikvision', 'Dahua Rtsp Server' и т.п.
    """
    try:
        fut = asyncio.open_connection(ip, port)
        reader, writer = await asyncio.wait_for(fut, timeout=CONNECT_TIMEOUT)

        request = (
            f"OPTIONS rtsp://{ip}:{port} RTSP/1.0\r\n"
            f"CSeq: 1\r\n"
            f"User-Agent: scanner\r\n\r\n"
        )
        writer.write(request.encode())
        await writer.drain()

        data = await asyncio.wait_for(reader.read(1024), timeout=CONNECT_TIMEOUT)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass

        text = data.decode("utf-8", errors="ignore")
        for line in text.split("\r\n"):
            if line.lower().startswith("server:"):
                return line.split(":", 1)[1].strip()
        return None
    except (asyncio.TimeoutError, OSError):
        return None


async def _scan_ip(ip: str) -> Optional[PortScanResult]:
    """Проверяет один IP по всем портам. Возвращает результат если что-то открыто."""
    ports_to_check = [RTSP_PORT] + HTTP_PORTS

    checks = await asyncio.gather(*[_check_port(ip, p) for p in ports_to_check])
    open_ports = [p for p, is_open in zip(ports_to_check, checks) if is_open]

    if not open_ports:
        return None

    has_rtsp = RTSP_PORT in open_ports
    vendor = None
    if has_rtsp:
        vendor = await _probe_rtsp_vendor(ip)

    return PortScanResult(
        ip=ip,
        open_ports=open_ports,
        has_rtsp=has_rtsp,
        vendor=vendor,
    )


def _build_ip_list(subnet_prefix: str, start: int, end: int) -> List[str]:
    """subnet_prefix='192.168.1.', 11..39 → ['192.168.1.11', ...]"""
    return [f"{subnet_prefix}{i}" for i in range(start, end + 1)]


def enumerate_local_subnets() -> List[LocalSubnet]:
    """
    Все локальные IPv4-подсети /24 по адресам поднятых интерфейсов.

    Берём именно все адреса каждого интерфейса: на одном интерфейсе их может
    быть несколько (камерная сеть + внешняя), и вариант с ioctl вернул бы
    только первый. Погашенные интерфейсы пропускаем — иначе в список лезут
    docker-мосты, чьи подсети никуда не ведут.
    """
    import socket as _socket
    import psutil

    subnets: List[LocalSubnet] = []
    seen: set[str] = set()

    try:
        stats = psutil.net_if_stats()
        for iface, addrs in psutil.net_if_addrs().items():
            st = stats.get(iface)
            if st is None or not st.isup:
                continue
            for a in addrs:
                if a.family != _socket.AF_INET or not a.address:
                    continue
                if a.address.startswith("127.") or a.address.startswith("169.254."):
                    continue
                parts = a.address.split(".")
                if len(parts) != 4:
                    continue
                prefix = ".".join(parts[:3]) + "."
                if prefix in seen:
                    continue
                seen.add(prefix)
                subnets.append(LocalSubnet(prefix=prefix, address=a.address, iface=iface))
    except Exception as e:
        logger.warning(f"enumerate_local_subnets failed: {e}")

    return subnets


async def scan_subnets_batched(
        subnet_prefixes: List[str],
        start: int,
        end: int,
        exclude_ips: Optional[set[str]] = None,
) -> AsyncGenerator[dict, None]:
    """
    Последовательно сканирует несколько подсетей батчами по BATCH_SIZE.

    Счётчик сквозной по всем подсетям — прогресс-бар едет от 0 до 100 один раз.
    Первый yield всегда type='start', дальше type='progress' после каждого батча:

      { "type": "start",    "total": int, "subnets": [str, ...] }
      { "type": "progress", "scanned": int, "total": int,
        "subnet": str, "found": [PortScanResult-dict, ...] }
    """
    exclude_ips = exclude_ips or set()

    # Списки строим заранее: total нужен до первого батча, а исключения его меняют
    planned = [
        (prefix, [ip for ip in _build_ip_list(prefix, start, end) if ip not in exclude_ips])
        for prefix in subnet_prefixes
    ]
    total = sum(len(ips) for _, ips in planned)
    scanned = 0

    yield {
        "type": "start",
        "total": total,
        "subnets": [prefix for prefix, _ in planned],
    }

    for prefix, ips in planned:
        for i in range(0, len(ips), BATCH_SIZE):
            batch = ips[i:i + BATCH_SIZE]
            results = await asyncio.gather(*[_scan_ip(ip) for ip in batch])
            found = [asdict(r) for r in results if r is not None]
            scanned += len(batch)

            yield {
                "type": "progress",
                "scanned": scanned,
                "total": total,
                "subnet": prefix,
                "found": found,
            }