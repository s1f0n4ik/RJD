from __future__ import annotations

import asyncio
import ipaddress
import math
import struct
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

from app.models import ChannelDescriptor, ChannelType, ChannelValue, DeviceState
from app.registry import DeviceDriver

DATAGRAM_SIZE = 1206
BLOCKS_PER_DATAGRAM = 12
POINTS_PER_BLOCK = 32
BLOCK_STRUCT = struct.Struct("<HH" + "HB" * POINTS_PER_BLOCK)
BLOCK_SIZE = BLOCK_STRUCT.size
BLOCK_MARKER = 0xEEFF


class LakiBeamParser:
    def __init__(self, resolution_deg: float = 0.05):
        if resolution_deg <= 0:
            raise ValueError("resolution_deg must be positive")
        self.resolution_deg = resolution_deg
        self.points: list[dict[str, int | float]] = []
        self.last_azimuth: float | None = None
        self.sequence = 0

    def feed(self, data: bytes) -> list[dict[str, Any]]:
        if len(data) != DATAGRAM_SIZE:
            return []
        completed: list[dict[str, Any]] = []
        for block_index in range(BLOCKS_PER_DATAGRAM):
            block = BLOCK_STRUCT.unpack_from(data, block_index * BLOCK_SIZE)
            marker, azimuth_raw = block[:2]
            if marker != BLOCK_MARKER:
                continue
            azimuth = azimuth_raw / 100.0
            if self.last_azimuth is not None and azimuth < self.last_azimuth and self.points:
                self.sequence += 1
                completed.append({
                    "sequence": self.sequence,
                    "captured_at": datetime.now(UTC).isoformat(),
                    "source": "real",
                    "points": self.points,
                })
                self.points = []
            values = block[2:]
            for point_index in range(POINTS_PER_BLOCK):
                distance = values[point_index * 2]
                if distance == 0:
                    continue
                self.points.append({
                    "angle_deg": round((azimuth + point_index * self.resolution_deg) % 360.0, 4),
                    "distance_mm": distance,
                    "intensity": values[point_index * 2 + 1],
                })
            self.last_azimuth = azimuth
        return completed


class _Protocol(asyncio.DatagramProtocol):
    def __init__(self, expected_ip: str, parser: LakiBeamParser, on_scan):
        self.expected_ip = str(ipaddress.ip_address(expected_ip))
        self.parser = parser
        self.on_scan = on_scan
        self.last_packet_at: float | None = None

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        if addr[0] != self.expected_ip:
            return
        self.last_packet_at = asyncio.get_running_loop().time()
        for scan in self.parser.feed(data):
            self.on_scan(scan)


class LakiBeamDriver(DeviceDriver):
    @property
    def channels(self) -> list[ChannelDescriptor]:
        return [ChannelDescriptor(
            id="scan",
            name="Скан LakiBeam",
            unit="mm",
            type=ChannelType.SCAN,
            frequency_hz=float(self.config.get("frequency_hz", 15.0)),
        )]

    async def start(self) -> None:
        self.state = DeviceState.STARTING
        self.message = None
        self._stop = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name=f"lakibeam-{self.device_id}")

    async def stop(self) -> None:
        if task := getattr(self, "_task", None):
            self._stop.set()
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            self._task = None
        self.state = DeviceState.STOPPED

    async def _run(self) -> None:
        try:
            if self.config.get("mode", "real") == "demo":
                await self._demo()
            else:
                await self._real()
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - состояние драйвера должно пережить аппаратную ошибку
            self.state = DeviceState.ERROR
            self.message = str(error)

    async def _demo(self) -> None:
        fps = max(0.1, float(self.config.get("frequency_hz", 15.0)))
        count = max(8, int(self.config.get("points", 811)))
        sequence = 0
        while not self._stop.is_set():
            sequence += 1
            phase = sequence / 15.0
            points = []
            for index in range(count):
                angle = -45.0 + 270.0 * index / max(1, count - 1)
                radians = math.radians(angle)
                distance = int(3200 + 450 * math.sin(radians * 3 + phase))
                points.append({"angle_deg": round(angle, 4), "distance_mm": distance, "intensity": 100})
            self._publish_scan({
                "sequence": sequence,
                "captured_at": datetime.now(UTC).isoformat(),
                "source": "demo",
                "points": points,
            })
            await asyncio.sleep(1.0 / fps)

    async def _real(self) -> None:
        ip = str(self.config.get("ip", "192.168.198.2"))
        bind_host = str(self.config.get("bind_host", "0.0.0.0"))
        port = int(self.config.get("udp_port", 2368))
        timeout = max(0.2, float(self.config.get("packet_timeout_sec", 2.0)))
        parser = LakiBeamParser(float(self.config.get("resolution_deg", 0.05)))
        loop = asyncio.get_running_loop()
        protocol = _Protocol(ip, parser, self._publish_scan)
        transport, _ = await loop.create_datagram_endpoint(lambda: protocol, local_addr=(bind_host, port))
        try:
            while not self._stop.is_set():
                await asyncio.sleep(0.5)
                if protocol.last_packet_at is None or loop.time() - protocol.last_packet_at > timeout:
                    self.state = DeviceState.UNAVAILABLE
                    self.message = "no UDP packets from LakiBeam"
        finally:
            transport.close()

    def _publish_scan(self, scan: dict[str, Any]) -> None:
        self.state = DeviceState.RUNNING
        self.message = None
        self.publish(ChannelValue(device_id=self.device_id, channel_id="scan", value=scan))
