from __future__ import annotations

from typing import Any

from app.devices.modbus import PollingModbusDriver
from app.models import ChannelDescriptor, ChannelType, ChannelValue, PeripheralEvent

TEMPERATURE_NAMES = {
    "air": "Температура воздуха",
    "left_rail": "Температура левого рельса",
    "ballast": "Температура балласта",
    "right_rail": "Температура правого рельса",
}
DEFAULT_PAIR_TARGETS = ("air", "left_rail", "ballast", "right_rail")


def _temperature_channels(targets: list[str]) -> list[ChannelDescriptor]:
    channels = [
        ChannelDescriptor(id=target, name=TEMPERATURE_NAMES[target], unit="°C", frequency_hz=1)
        for target in dict.fromkeys(targets)
        if target in TEMPERATURE_NAMES
    ]
    if "air" in targets:
        for target in ("left_rail", "ballast", "right_rail"):
            if target in targets:
                channels.extend([
                    ChannelDescriptor(
                        id=f"{target}_delta_air",
                        name=f"Превышение {TEMPERATURE_NAMES[target].lower()} к воздуху",
                        unit="°C",
                        frequency_hz=1,
                    ),
                    ChannelDescriptor(
                        id=f"{target}_overheat",
                        name=f"Перегрев {TEMPERATURE_NAMES[target].lower()}",
                        type=ChannelType.BOOLEAN,
                        frequency_hz=1,
                    ),
                ])
    return channels


class PyrometerBoardDriver(PollingModbusDriver):
    """Плата-концентратор: четыре входа, по два регистра на температуру."""

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        targets = self.config.get("pair_targets", list(DEFAULT_PAIR_TARGETS))
        if not isinstance(targets, list) or len(targets) != 4:
            raise ValueError("pyrometer_board pair_targets must contain four channels")
        if any(target not in {*TEMPERATURE_NAMES, "none"} for target in targets):
            raise ValueError("Unknown pyrometer_board pair target")
        self.targets = targets
        self.start_register = int(self.config.get("start_register", 999))
        self.holding = bool(self.config.get("holding_registers", False))
        self.minimum = float(self.config.get("temperature_min", 0))
        self.maximum = float(self.config.get("temperature_max", 100))
        self.max_delta = float(self.config.get("max_delta", 20))

    @property
    def channels(self) -> list[ChannelDescriptor]:
        return [
            *_temperature_channels(self.targets),
            ChannelDescriptor(
                id="raw_registers",
                name="Сырые регистры платы",
                type=ChannelType.ARRAY,
                frequency_hz=1,
            ),
        ]

    async def poll(self) -> None:
        registers = await self.exchange(
            lambda client: client.read_registers(self.start_register, 8, self.holding)
        )
        self.accept_registers(registers)

    def accept_registers(self, registers: list[int]) -> None:
        if len(registers) != 8:
            raise ValueError("Pyrometer board requires eight registers")
        values: dict[str, float] = {}
        for pair, target in enumerate(self.targets):
            if target == "none":
                continue
            value = registers[pair * 2] + registers[pair * 2 + 1] / 100
            if self.minimum <= value <= self.maximum:
                values.setdefault(target, value)
                self.publish(ChannelValue(device_id=self.device_id, channel_id=target, value=value))
        air = values.get("air")
        if air is not None:
            for target in ("left_rail", "ballast", "right_rail"):
                if target not in values:
                    continue
                delta = values[target] - air
                self.publish(ChannelValue(
                    device_id=self.device_id,
                    channel_id=f"{target}_delta_air",
                    value=delta,
                ))
                self.publish(ChannelValue(
                    device_id=self.device_id,
                    channel_id=f"{target}_overheat",
                    value=delta > self.max_delta,
                ))
        self.publish(ChannelValue(
            device_id=self.device_id,
            channel_id="raw_registers",
            value=list(registers),
        ))


class KelvinDriver(PollingModbusDriver):
    STATUS_START = 0x0400
    EMISSIVITY_REGISTER = 0x1FFF
    BIT_MEASUREMENT_OK = 4
    BIT_TIMEOUT = 7
    BIT_UNSTABLE = 10

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.object_target = str(self.config.get("object_target", "none"))
        self.ambient_target = str(self.config.get("ambient_target", "none"))
        if self.object_target not in {*TEMPERATURE_NAMES, "none"}:
            raise ValueError("Unknown Kelvin object_target")
        if self.ambient_target not in {*TEMPERATURE_NAMES, "none"}:
            raise ValueError("Unknown Kelvin ambient_target")
        self.use_filtered = bool(self.config.get("use_filtered", False))
        self.minimum = float(self.config.get("temperature_min", -50))
        self.maximum = float(self.config.get("temperature_max", 350))
        self.max_delta = float(self.config.get("max_delta", 20))
        self.emissivity = float(self.config.get("emissivity", 0.95))
        if not 0.01 <= self.emissivity <= 1:
            raise ValueError("Kelvin emissivity must be in 0.01..1.00")
        self.write_emissivity = bool(self.config.get("write_emissivity", False))
        self._emissivity_checked = False

    @property
    def channels(self) -> list[ChannelDescriptor]:
        targets = [target for target in (self.object_target, self.ambient_target) if target != "none"]
        return [
            *_temperature_channels(targets),
            ChannelDescriptor(id="object_filtered", name="Объект, фильтр", unit="°C", frequency_hz=1),
            ChannelDescriptor(id="object_instant", name="Объект, мгновенно", unit="°C", frequency_hz=1),
            ChannelDescriptor(id="sensor_ambient", name="Температура электроники", unit="°C", frequency_hz=1),
            ChannelDescriptor(id="emissivity", name="Коэффициент излучения", frequency_hz=0),
            ChannelDescriptor(
                id="unstable",
                name="Переходный процесс",
                type=ChannelType.BOOLEAN,
                frequency_hz=1,
            ),
        ]

    async def poll(self) -> None:
        if not self._emissivity_checked:
            raw = (await self.exchange(
                lambda client: client.read_registers(self.EMISSIVITY_REGISTER, 1, True)
            ))[0]
            actual = raw / 65535
            self.publish(ChannelValue(
                device_id=self.device_id,
                channel_id="emissivity",
                value=actual,
            ))
            if self.write_emissivity and abs(actual - self.emissivity) > 1 / 65535:
                value = round(self.emissivity * 65535)
                await self.exchange(lambda client: client.write_register(self.EMISSIVITY_REGISTER, value))
                self.emit(PeripheralEvent(
                    device_id=self.device_id,
                    kind="emissivity_written",
                    payload={"value": self.emissivity, "power_cycle_required": True},
                ))
            self._emissivity_checked = True
        registers = await self.exchange(
            lambda client: client.read_registers(self.STATUS_START, 4)
        )
        self.accept_registers(registers)

    def accept_registers(self, registers: list[int]) -> None:
        if len(registers) != 4:
            raise ValueError("Kelvin status requires four registers")
        state = registers[0]
        if state & (1 << self.BIT_TIMEOUT):
            raise ValueError("Kelvin reports measurement timeout")
        if not state & (1 << self.BIT_MEASUREMENT_OK):
            raise ValueError("Kelvin did not confirm a valid temperature")
        filtered, instant, ambient = (self._signed(value) / 10 for value in registers[1:])
        for channel, value in (
            ("object_filtered", filtered),
            ("object_instant", instant),
            ("sensor_ambient", ambient),
        ):
            self.publish(ChannelValue(device_id=self.device_id, channel_id=channel, value=value))
        self.publish(ChannelValue(
            device_id=self.device_id,
            channel_id="unstable",
            value=bool(state & (1 << self.BIT_UNSTABLE)),
        ))
        selected = filtered if self.use_filtered else instant
        mapped: dict[str, float] = {}
        for target, value in ((self.object_target, selected), (self.ambient_target, ambient)):
            if target != "none" and self.minimum <= value <= self.maximum:
                mapped.setdefault(target, value)
                self.publish(ChannelValue(device_id=self.device_id, channel_id=target, value=value))
        air = mapped.get("air")
        if air is not None:
            for target in ("left_rail", "ballast", "right_rail"):
                if target not in mapped:
                    continue
                delta = mapped[target] - air
                self.publish(ChannelValue(
                    device_id=self.device_id,
                    channel_id=f"{target}_delta_air",
                    value=delta,
                ))
                self.publish(ChannelValue(
                    device_id=self.device_id,
                    channel_id=f"{target}_overheat",
                    value=delta > self.max_delta,
                ))

    @staticmethod
    def _signed(value: int) -> int:
        return value - 65536 if value & 0x8000 else value


class DiscreteDriver(PollingModbusDriver):
    """Дискретный модуль: устойчивое 3 = СТАРТ, значение меньше 3 = СТОП."""

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.start_register = int(self.config.get("start_register", 999))
        self.holding = bool(self.config.get("holding_registers", False))
        self.debounce_samples = max(1, int(self.config.get("debounce_samples", 10)))
        self._candidate: bool | None = None
        self._candidate_count = 0
        self._trip: bool | None = None

    @property
    def channels(self) -> list[ChannelDescriptor]:
        return [
            ChannelDescriptor(id="state", name="Код дискретного входа", frequency_hz=1),
            ChannelDescriptor(
                id="trip",
                name="СТАРТ измерительной поездки",
                type=ChannelType.BOOLEAN,
                frequency_hz=1,
            ),
            ChannelDescriptor(
                id="raw_registers",
                name="Сырые регистры дискретного модуля",
                type=ChannelType.ARRAY,
                frequency_hz=1,
            ),
        ]

    async def poll(self) -> None:
        registers = await self.exchange(
            lambda client: client.read_registers(self.start_register, 5, self.holding)
        )
        self.accept_registers(registers)

    def accept_registers(self, registers: list[int]) -> None:
        if len(registers) != 5:
            raise ValueError("Discrete module requires five registers")
        state = registers[0]
        trip = True if state == 3 else False if state < 3 else None
        self.publish(ChannelValue(device_id=self.device_id, channel_id="state", value=state))
        self.publish(ChannelValue(
            device_id=self.device_id,
            channel_id="raw_registers",
            value=list(registers),
        ))
        if trip is None:
            self._candidate = None
            self._candidate_count = 0
            return
        if trip != self._candidate:
            self._candidate = trip
            self._candidate_count = 1
        else:
            self._candidate_count += 1
        if self._candidate_count < self.debounce_samples or trip == self._trip:
            return
        self._trip = trip
        self.publish(ChannelValue(device_id=self.device_id, channel_id="trip", value=trip))
        self.emit(PeripheralEvent(
            device_id=self.device_id,
            kind="trip_changed",
            payload={"active": trip, "state": state},
        ))
