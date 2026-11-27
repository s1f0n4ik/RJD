from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from time import monotonic
from typing import Any

import serial


@dataclass(frozen=True)
class SerialSettings:
    port: str
    baudrate: int = 9600
    bytesize: int = 8
    parity: str = "N"
    stopbits: float = 1
    timeout: float = 1.0
    request_gap: float = 0.05

    @classmethod
    def from_config(cls, source: dict[str, Any]) -> SerialSettings:
        parity = str(source.get("parity", "N")).upper()
        if parity not in {"N", "E", "O"}:
            raise ValueError("Serial parity must be N, E or O")
        stopbits = float(source.get("stopbits", 1))
        if stopbits not in {1.0, 1.5, 2.0}:
            raise ValueError("Serial stopbits must be 1, 1.5 or 2")
        bytesize = int(source.get("bytesize", 8))
        if bytesize not in {5, 6, 7, 8}:
            raise ValueError("Serial bytesize must be in 5..8")
        port = str(source.get("port", "")).strip()
        if not port:
            raise ValueError("Serial port is required")
        return cls(
            port=port,
            baudrate=int(source.get("baudrate", 9600)),
            bytesize=bytesize,
            parity=parity,
            stopbits=stopbits,
            timeout=max(0.05, int(source.get("timeout_ms", 1000)) / 1000),
            request_gap=max(0.0, int(source.get("request_gap_ms", 50)) / 1000),
        )


class SerialLine:
    """Единственный владелец физического последовательного порта."""

    def __init__(self, settings: SerialSettings):
        self.settings = settings
        self.port = settings.port
        self.baudrate = settings.baudrate
        self._serial: serial.Serial | None = None
        self._lock = asyncio.Lock()
        self._last_exchange = 0.0

    @property
    def is_open(self) -> bool:
        return bool(self._serial is not None and self._serial.is_open)

    async def exchange(
        self,
        operation: Callable[[serial.Serial], Any],
        *,
        timeout: float | None = None,
        request_gap: float | None = None,
    ) -> Any:
        async with self._lock:
            wait = (self.settings.request_gap if request_gap is None else request_gap) - (monotonic() - self._last_exchange)
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                return await asyncio.to_thread(self._exchange_sync, operation, timeout)
            finally:
                self._last_exchange = monotonic()

    def _exchange_sync(self, operation: Callable[[serial.Serial], Any], timeout: float | None) -> Any:
        if self._serial is None or not self._serial.is_open:
            self._serial = serial.Serial(
                port=self.settings.port,
                baudrate=self.settings.baudrate,
                bytesize=self.settings.bytesize,
                parity=self.settings.parity,
                stopbits=self.settings.stopbits,
                timeout=self.settings.timeout,
                write_timeout=self.settings.timeout,
            )
        if timeout is not None:
            self._serial.timeout = timeout
            self._serial.write_timeout = timeout
        try:
            return operation(self._serial)
        except Exception:
            self._serial.close()
            self._serial = None
            raise

    async def close(self) -> None:
        async with self._lock:
            if self._serial is not None:
                await asyncio.to_thread(self._serial.close)
                self._serial = None


class LineManager:
    def __init__(self):
        self._lines: dict[str, SerialLine] = {}

    def line(
        self,
        port_or_settings: str | SerialSettings,
        baudrate: int | None = None,
        timeout: float = 0.5,
    ) -> SerialLine:
        settings = (
            port_or_settings
            if isinstance(port_or_settings, SerialSettings)
            else SerialSettings(port=port_or_settings, baudrate=baudrate or 9600, timeout=timeout)
        )
        line = self._lines.get(settings.port)
        if line is None:
            line = SerialLine(settings)
            self._lines[settings.port] = line
        elif (
            line.settings.baudrate,
            line.settings.bytesize,
            line.settings.parity,
            line.settings.stopbits,
        ) != (
            settings.baudrate,
            settings.bytesize,
            settings.parity,
            settings.stopbits,
        ):
            raise ValueError(
                f"Serial port {settings.port} already has incompatible settings: "
                f"{line.settings.baudrate}/{line.settings.parity}/{line.settings.stopbits}"
            )
        return line

    async def close(self) -> None:
        await asyncio.gather(*(line.close() for line in self._lines.values()))
        self._lines.clear()
