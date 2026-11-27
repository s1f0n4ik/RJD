from __future__ import annotations

import asyncio
import struct
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

from app.models import ChannelDescriptor, ChannelType, ChannelValue, DeviceState
from app.registry import DeviceDriver


def _signed_hex(value: str, bits: int = 32) -> int:
    raw = int(value, 16)
    sign = 1 << (bits - 1)
    return raw - (1 << bits) if raw & sign else raw


def _float_hex(value: str) -> float:
    return struct.unpack(">f", bytes.fromhex(value.zfill(8)))[0]


class SickColaAParser:
    """Собирает CoLa-A телеграммы и приводит DIST1/RSSI1 к общему скану."""

    def __init__(self):
        self.buffer = bytearray()
        self.sequence = 0
        self.device_ident: str | None = None

    def feed(self, data: bytes) -> list[dict[str, Any]]:
        self.buffer.extend(data)
        scans: list[dict[str, Any]] = []
        while True:
            try:
                start = self.buffer.index(0x02)
            except ValueError:
                self.buffer.clear()
                break
            try:
                end = self.buffer.index(0x03, start + 1)
            except ValueError:
                if start:
                    del self.buffer[:start]
                break
            telegram = bytes(self.buffer[start + 1:end])
            del self.buffer[:end + 1]
            scan = self.parse_telegram(telegram)
            if scan is not None:
                scans.append(scan)
        return scans

    def parse_telegram(self, telegram: bytes) -> dict[str, Any] | None:
        tokens = telegram.decode("ascii", "replace").split()
        if "DeviceIdent" in tokens:
            at = tokens.index("DeviceIdent")
            # Строки SICK предваряются своей hex-длиной: 6 TiM561 E V2...
            self.device_ident = " ".join(
                token for token in tokens[at + 1:]
                if not (len(token) <= 4 and all(char in "0123456789abcdefABCDEF" for char in token))
            ) or None
            return None
        if "LMDscandata" not in tokens or "DIST1" not in tokens:
            return None

        at = tokens.index("DIST1")
        if at + 6 > len(tokens):
            return None
        try:
            scale = _float_hex(tokens[at + 1])
            offset = _float_hex(tokens[at + 2])
            start_angle = _signed_hex(tokens[at + 3]) / 10_000.0
            angle_step = int(tokens[at + 4], 16) / 10_000.0
            count = int(tokens[at + 5], 16)
            raw_distances = tokens[at + 6:at + 6 + count]
            if count <= 0 or len(raw_distances) != count:
                return None

            intensities: list[int] = []
            if "RSSI1" in tokens:
                rssi = tokens.index("RSSI1")
                rssi_count = int(tokens[rssi + 5], 16)
                intensities = [int(item, 16) for item in tokens[rssi + 6:rssi + 6 + rssi_count]]

            points: list[dict[str, int | float]] = []
            for index, token in enumerate(raw_distances):
                distance = round(int(token, 16) * scale + offset)
                if distance <= 0:
                    continue
                points.append({
                    "angle_deg": round(start_angle + index * angle_step, 4),
                    "distance_mm": distance,
                    "intensity": intensities[index] if index < len(intensities) else 0,
                })
        except (ValueError, IndexError, struct.error):
            return None

        self.sequence += 1
        return {
            "sequence": self.sequence,
            "captured_at": datetime.now(UTC).isoformat(),
            "source": "sick_cola_a",
            "device_ident": self.device_ident,
            "points": points,
        }


class SickColaADriver(DeviceDriver):
    @property
    def channels(self) -> list[ChannelDescriptor]:
        return [ChannelDescriptor(
            id="scan",
            name="Скан LiDAR",
            unit="mm",
            type=ChannelType.SCAN,
            frequency_hz=float(self.config.get("frequency_hz", 15.0)),
        )]

    @staticmethod
    def candidate_ports(config: dict[str, Any]) -> list[int]:
        configured = config.get("tcp_port")
        if configured is not None:
            return [int(configured)]
        return [2111, 2112]

    @classmethod
    async def probe(cls, config: dict[str, Any]) -> tuple[bool, int | None, str | None]:
        host = str(config.get("ip", "")).strip()
        if not host:
            return False, None, None
        timeout = max(0.2, float(config.get("connect_timeout_sec", 1.5)))
        for port in cls.candidate_ports(config):
            writer: asyncio.StreamWriter | None = None
            try:
                reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
                writer.write(b"\x02sRN DeviceIdent\x03")
                await writer.drain()
                reply = await asyncio.wait_for(reader.readuntil(b"\x03"), timeout)
                parser = SickColaAParser()
                parser.feed(reply)
                if parser.device_ident:
                    return True, port, parser.device_ident
            except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
                pass
            finally:
                if writer is not None:
                    writer.close()
                    with suppress(Exception):
                        await writer.wait_closed()
        return False, None, None

    async def start(self) -> None:
        self.state = DeviceState.STARTING
        self.message = None
        self._stop = asyncio.Event()
        self._writer: asyncio.StreamWriter | None = None
        self._task = asyncio.create_task(self._run(), name=f"sick-cola-a-{self.device_id}")

    async def stop(self) -> None:
        self._stop.set()
        writer = getattr(self, "_writer", None)
        if writer is not None and not writer.is_closing():
            with suppress(Exception):
                writer.write(b"\x02sEN LMDscandata 0\x03")
                await writer.drain()
        if task := getattr(self, "_task", None):
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            self._task = None
        await self._close_writer()
        self.state = DeviceState.STOPPED

    async def _run(self) -> None:
        host = str(self.config.get("ip", "")).strip()
        if not host:
            self.state = DeviceState.ERROR
            self.message = "SICK LiDAR IP is required"
            return
        connect_timeout = max(0.2, float(self.config.get("connect_timeout_sec", 2.0)))
        packet_timeout = max(0.5, float(self.config.get("packet_timeout_sec", 3.0)))
        reconnect = max(0.2, float(self.config.get("reconnect_sec", 1.0)))

        while not self._stop.is_set():
            try:
                reader, self._writer, port = await self._connect(host, connect_timeout)
                parser = SickColaAParser()
                self.message = f"SICK CoLa-A {host}:{port}, ожидание скана"
                self._writer.write(b"\x02sRN DeviceIdent\x03\x02sEN LMDscandata 1\x03")
                await self._writer.drain()
                while not self._stop.is_set():
                    chunk = await asyncio.wait_for(reader.read(65536), packet_timeout)
                    if not chunk:
                        raise ConnectionError("соединение закрыто прибором")
                    for scan in parser.feed(chunk):
                        scan["device_ident"] = parser.device_ident
                        self.publish(ChannelValue(device_id=self.device_id, channel_id="scan", value=scan))
                        self.state = DeviceState.RUNNING
                        self.message = None
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - драйвер переподключается после любого сбоя транспорта
                self.state = DeviceState.UNAVAILABLE
                self.message = f"SICK CoLa-A: {error}"
            finally:
                await self._close_writer()
            if not self._stop.is_set():
                await asyncio.sleep(reconnect)

    async def _connect(self, host: str, timeout: float) -> tuple[asyncio.StreamReader, asyncio.StreamWriter, int]:
        errors: list[str] = []
        for port in self.candidate_ports(self.config):
            try:
                reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
                return reader, writer, port
            except (OSError, asyncio.TimeoutError) as error:
                errors.append(f"{port}: {error}")
        raise ConnectionError("; ".join(errors) or "нет доступных TCP-портов")

    async def _close_writer(self) -> None:
        writer = getattr(self, "_writer", None)
        self._writer = None
        if writer is not None:
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()
