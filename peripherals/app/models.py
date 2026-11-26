from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class ChannelType(StrEnum):
    NUMBER = "number"
    ARRAY = "array"
    SCAN = "scan"
    BOOLEAN = "boolean"


class DeviceState(StrEnum):
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    UNAVAILABLE = "unavailable"
    ERROR = "error"


class ChannelDescriptor(BaseModel):
    id: str
    name: str
    unit: str = ""
    type: ChannelType = ChannelType.NUMBER
    frequency_hz: float = 0.0


class DeviceDescriptor(BaseModel):
    id: str
    kind: str
    name: str
    state: DeviceState
    message: str | None = None
    channels: list[ChannelDescriptor] = Field(default_factory=list)


class ChannelValue(BaseModel):
    device_id: str
    channel_id: str
    value: Any
    captured_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    sequence: int = 0


class PeripheralEvent(BaseModel):
    device_id: str
    kind: str
    payload: dict[str, Any] = Field(default_factory=dict)
    captured_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class GatewayTime(BaseModel):
    unix_ms: int = 0
    lat: float = 0.0
    lon: float = 0.0
    alt: float = 0.0
    gps_valid: bool = False
    tz_offset_min: int = 0
    can_time: bool = False
    ntp_time: bool = False
    trip: dict[str, Any] | None = None
    updated_at: datetime | None = None
