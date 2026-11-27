from __future__ import annotations

import asyncio
import os
from abc import ABC, abstractmethod
from collections import deque
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from time import monotonic
from typing import Any

from app.line import LineManager
from app.models import (
    ChannelDescriptor,
    ChannelValue,
    DeviceDescriptor,
    DeviceState,
    GatewayTime,
    PeripheralEvent,
)


class DeviceDriver(ABC):
    def __init__(
        self,
        device_id: str,
        config: dict[str, Any],
        publish: Callable[[ChannelValue], None],
        emit: Callable[[PeripheralEvent], None],
        lines: LineManager,
    ):
        self.device_id = device_id
        self.config = config
        self.publish = publish
        self.emit = emit
        self.lines = lines
        self.state = DeviceState.STOPPED
        self.message: str | None = None
        self.started_at: datetime | None = None
        self.last_success_at: datetime | None = None
        self.last_error_at: datetime | None = None
        self.success_count = 0
        self.error_count = 0
        self.consecutive_errors = 0
        self.reconnect_count = 0
        self._success_times: deque[float] = deque(maxlen=120)

    def record_started(self) -> None:
        self.started_at = datetime.now(UTC)

    def record_success(self) -> None:
        self.last_success_at = datetime.now(UTC)
        self.success_count += 1
        self.consecutive_errors = 0
        self._success_times.append(monotonic())

    def record_error(self, *, reconnect: bool = False) -> None:
        self.last_error_at = datetime.now(UTC)
        self.error_count += 1
        self.consecutive_errors += 1
        if reconnect:
            self.reconnect_count += 1

    def diagnostics(self) -> dict[str, Any]:
        observed_hz = 0.0
        if len(self._success_times) > 1:
            elapsed = self._success_times[-1] - self._success_times[0]
            if elapsed > 0:
                observed_hz = (len(self._success_times) - 1) / elapsed
        result: dict[str, Any] = {
            "started_at": self.started_at,
            "last_success_at": self.last_success_at,
            "last_error_at": self.last_error_at,
            "success_count": self.success_count,
            "error_count": self.error_count,
            "consecutive_errors": self.consecutive_errors,
            "reconnect_count": self.reconnect_count,
            "observed_hz": round(observed_hz, 2),
        }
        port = self.config.get("port")
        if port:
            line = getattr(self, "line", None)
            result["transport"] = {
                "type": "serial",
                "port": str(port),
                "adapter_present": os.path.exists(str(port)),
                "port_open": bool(line and line.is_open),
                "baudrate": int(self.config.get("baudrate", 9600)),
                "format": f"{int(self.config.get('bytesize', 8))}{str(self.config.get('parity', 'N')).upper()}{self.config.get('stopbits', 1)}",
                "slave_id": self.config.get("slave_id"),
            }
        elif self.config.get("ip"):
            result["transport"] = {
                "type": "network",
                "host": str(self.config["ip"]),
                "port": self.config.get("tcp_port") or self.config.get("udp_port"),
                "protocol": self.config.get("selected_protocol") or self.config.get("protocol"),
            }
        return result

    @property
    @abstractmethod
    def channels(self) -> list[ChannelDescriptor]:
        raise NotImplementedError

    @abstractmethod
    async def start(self) -> None:
        raise NotImplementedError

    @abstractmethod
    async def stop(self) -> None:
        raise NotImplementedError

    def describe(self) -> DeviceDescriptor:
        return DeviceDescriptor(
            id=self.device_id,
            kind=str(self.config["kind"]),
            name=str(self.config.get("name") or self.device_id),
            state=self.state,
            message=self.message,
            channels=self.channels,
            diagnostics=self.diagnostics(),
        )


class DescriptorDriver(DeviceDriver):
    """Безопасный драйвер каркаса: описывает каналы, но не открывает оборудование."""

    @property
    def channels(self) -> list[ChannelDescriptor]:
        return [ChannelDescriptor.model_validate(item) for item in self.config.get("channels", [])]

    async def start(self) -> None:
        self.record_started()
        self.record_success()
        self.state = DeviceState.RUNNING
        self.message = None

    async def stop(self) -> None:
        self.state = DeviceState.STOPPED


DriverFactory = type[DeviceDriver]


class Registry:
    def __init__(self):
        self.lines = LineManager()
        from app.devices.lakibeam import LakiBeamDriver
        from app.devices.lidar import UniversalLidarDriver
        from app.devices.pyrometers import (
            DiscreteDriver,
            KelvinDriver,
            PyrometerBoardDriver,
        )

        self._factories: dict[str, DriverFactory] = {
            "descriptor": DescriptorDriver,
            "lakibeam": LakiBeamDriver,
            "lidar": UniversalLidarDriver,
            "pyrometer_board": PyrometerBoardDriver,
            "kelvin": KelvinDriver,
            "discrete": DiscreteDriver,
        }
        self._devices: dict[str, DeviceDriver] = {}
        self._values: dict[tuple[str, str], ChannelValue] = {}
        self._value_subscribers: set[asyncio.Queue[ChannelValue]] = set()
        self._event_subscribers: set[asyncio.Queue[PeripheralEvent]] = set()
        self._sequence = 0
        self.gateway_time = GatewayTime()

    def register(self, kind: str, factory: DriverFactory) -> None:
        if not kind or kind in self._factories:
            raise ValueError(f"Driver kind already registered: {kind}")
        self._factories[kind] = factory

    async def configure(self, source: dict[str, Any]) -> None:
        await self.stop()
        devices: dict[str, DeviceDriver] = {}
        for device_id, body in sorted(source.items()):
            if not isinstance(body, dict) or not isinstance(body.get("kind"), str):
                raise ValueError(f"Invalid peripheral {device_id}")  # noqa: TRY004 - ошибка пакета конфигурации
            factory = self._factories.get(body["kind"])
            if factory is None:
                raise ValueError(f"Unknown peripheral kind: {body['kind']}")
            devices[device_id] = factory(device_id, body, self._publish, self._emit, self.lines)
        self._devices = devices
        self._values.clear()

    async def start(self) -> None:
        for device in self._devices.values():
            device.state = DeviceState.STARTING
            try:
                await device.start()
            except Exception as error:  # noqa: BLE001 - один неисправный прибор не останавливает остальные
                device.state = DeviceState.ERROR
                device.message = str(error)

    async def stop(self) -> None:
        await asyncio.gather(*(device.stop() for device in self._devices.values()), return_exceptions=True)
        await self.lines.close()

    def describe(self) -> list[DeviceDescriptor]:
        now = datetime.now(UTC)
        result: list[DeviceDescriptor] = []
        for device in self._devices.values():
            descriptor = device.describe()
            channel_status: dict[str, Any] = {}
            for channel in descriptor.channels:
                value = self._values.get((descriptor.id, channel.id))
                age_ms = (now - value.captured_at).total_seconds() * 1000 if value else None
                poll_ms = float(device.config.get("poll_interval_ms", 0))
                stale_after_ms = (
                    max(3000.0, poll_ms * 3, 3000.0 / channel.frequency_hz)
                    if channel.frequency_hz > 0 else None
                )
                channel_status[channel.id] = {
                    "last_value_at": value.captured_at if value else None,
                    "age_ms": round(age_ms) if age_ms is not None else None,
                    "sequence": value.sequence if value else None,
                    "state": "no_data" if value is None else (
                        "stale" if stale_after_ms is not None and age_ms > stale_after_ms else "fresh"
                    ),
                }
            descriptor.diagnostics["channels"] = channel_status
            result.append(descriptor)
        return result

    def values(self) -> list[ChannelValue]:
        return list(self._values.values())

    def _publish(self, value: ChannelValue) -> None:
        self._sequence += 1
        value.sequence = self._sequence
        self._values[(value.device_id, value.channel_id)] = value
        for queue in tuple(self._value_subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(value)

    def _emit(self, event: PeripheralEvent) -> None:
        for queue in tuple(self._event_subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(event)

    async def subscribe_values(self) -> AsyncIterator[ChannelValue]:
        queue: asyncio.Queue[ChannelValue] = asyncio.Queue(maxsize=64)
        self._value_subscribers.add(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            self._value_subscribers.discard(queue)

    async def subscribe_events(self) -> AsyncIterator[PeripheralEvent]:
        queue: asyncio.Queue[PeripheralEvent] = asyncio.Queue(maxsize=64)
        self._event_subscribers.add(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            self._event_subscribers.discard(queue)

    def set_gateway_time(self, value: GatewayTime) -> None:
        value.updated_at = datetime.now(UTC)
        self.gateway_time = value
