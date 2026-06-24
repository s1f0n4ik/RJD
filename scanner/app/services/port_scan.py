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


def detect_local_subnet() -> Optional[str]:
    """
    Определяет локальную подсеть /24 по основному сетевому интерфейсу.
    Возвращает префикс вида '192.168.1.' или None.

    Метод: открываем UDP-сокет «наружу» (без отправки данных) и смотрим,
    какой локальный IP выбрала ОС — это IP основного интерфейса.
    """
    import socket as _socket
    try:
        s = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        # 8.8.8.8 — просто чтобы ОС выбрала исходящий интерфейс, пакет не шлётся
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        # 192.168.1.42 → '192.168.1.'
        parts = local_ip.split(".")
        if len(parts) == 4:
            return ".".join(parts[:3]) + "."
    except OSError as e:
        logger.warning(f"detect_local_subnet failed: {e}")
    return None


async def scan_ports_batched(
        subnet_prefix: str,
        start: int,
        end: int,
        exclude_ips: Optional[set[str]] = None,
) -> AsyncGenerator[dict, None]:
    """
    Сканирует диапазон IP батчами по BATCH_SIZE.
    Генератор: после каждого батча отдаёт прогресс и найденные камеры.

    Каждый yield — dict:
      { "type": "progress", "scanned": int, "total": int,
        "found": [PortScanResult-dict, ...] }   # found — накопительно за батч
    """
    exclude_ips = exclude_ips or set()
    all_ips = [ip for ip in _build_ip_list(subnet_prefix, start, end) if ip not in exclude_ips]
    total = len(all_ips)
    scanned = 0

    for i in range(0, total, BATCH_SIZE):
        batch = all_ips[i:i + BATCH_SIZE]
        results = await asyncio.gather(*[_scan_ip(ip) for ip in batch])
        found = [asdict(r) for r in results if r is not None]
        scanned += len(batch)

        yield {
            "type": "progress",
            "scanned": scanned,
            "total": total,
            "found": found,
        }