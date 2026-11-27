from __future__ import annotations

from typing import Any

from app.devices.lakibeam import LakiBeamDriver
from app.devices.sick import SickColaADriver
from app.models import ChannelDescriptor, ChannelType, DeviceDescriptor, DeviceState
from app.registry import DeviceDriver


class UniversalLidarDriver(DeviceDriver):
    """Выбирает протокольный адаптер, сохраняя единый контракт канала scan."""

    PROTOCOLS = {
        "lakibeam": LakiBeamDriver,
        "lakibeam_udp": LakiBeamDriver,
        "sick": SickColaADriver,
        "sick_cola_a": SickColaADriver,
    }

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.driver: DeviceDriver | None = None

    @property
    def channels(self) -> list[ChannelDescriptor]:
        if self.driver is not None:
            return self.driver.channels
        return [ChannelDescriptor(
            id="scan", name="Скан LiDAR", unit="mm",
            type=ChannelType.SCAN,
            frequency_hz=float(self.config.get("frequency_hz", 15.0)),
        )]

    async def start(self) -> None:
        self.state = DeviceState.STARTING
        protocol = str(self.config.get("protocol", "auto")).strip().lower()
        if protocol == "auto":
            detected, port, ident = await SickColaADriver.probe(self.config)
            if detected:
                protocol = "sick_cola_a"
                if self.config.get("tcp_port") is None and port is not None:
                    self.config["tcp_port"] = port
                self.config["detected_ident"] = ident
            elif self.config.get("tcp_port") is not None:
                # Явный TCP-порт означает SOPAS. Если прибор ещё загружается,
                # SICK-драйвер останется выбранным и переподключится позже.
                protocol = "sick_cola_a"
            else:
                protocol = "lakibeam_udp"
        factory = self.PROTOCOLS.get(protocol)
        if factory is None:
            self.state = DeviceState.ERROR
            self.message = f"Unknown LiDAR protocol: {protocol}"
            return
        self.config["selected_protocol"] = protocol
        self.driver = factory(self.device_id, self.config, self.publish, self.emit, self.lines)
        await self.driver.start()

    async def stop(self) -> None:
        if self.driver is not None:
            await self.driver.stop()
            self.driver = None
        self.state = DeviceState.STOPPED

    def describe(self) -> DeviceDescriptor:
        if self.driver is not None:
            return self.driver.describe()
        return super().describe()
