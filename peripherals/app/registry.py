from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
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
        )


class DescriptorDriver(DeviceDriver):
    """Безопасный драйвер каркаса: описывает каналы, но не открывает оборудование."""

    @property
    def channels(self) -> list[ChannelDescriptor]:
        return [ChannelDescriptor.model_validate(item) for item in self.config.get("channels", [])]

    async def start(self) -> None:
        self.state = DeviceState.RUNNING
        self.message = None

    async def stop(self) -> None:
        self.state = DeviceState.STOPPED


DriverFactory = type[DeviceDriver]


class Registry:
    def __init__(self):
        self.lines = LineManager()
        from app.devices.lakibeam import LakiBeamDriver
        from app.devices.pyrometers import (
            DiscreteDriver,
            KelvinDriver,
            PyrometerBoardDriver,
        )

        self._factories: dict[str, DriverFactory] = {
            "descriptor": DescriptorDriver,
            "lakibeam": LakiBeamDriver,
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
        return [device.describe() for device in self._devices.values()]

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
