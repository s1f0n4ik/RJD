from __future__ import annotations

import asyncio
import struct
from abc import abstractmethod
from typing import Any

import serial

from app.line import SerialLine, SerialSettings
from app.models import DeviceState, PeripheralEvent
from app.registry import DeviceDriver


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def frame(payload: bytes) -> bytes:
    return payload + struct.pack("<H", crc16(payload))


def _read_exact(port: serial.Serial, size: int) -> bytes:
    data = port.read(size)
    if len(data) != size:
        raise TimeoutError(f"Modbus response timeout: expected {size}, got {len(data)} bytes")
    return data


class ModbusRtu:
    def __init__(self, port: serial.Serial, slave_id: int):
        self.port = port
        self.slave_id = slave_id

    def _request(self, function: int, body: bytes) -> bytes:
        if hasattr(self.port, "reset_input_buffer"):
            self.port.reset_input_buffer()
        self.port.write(frame(bytes((self.slave_id, function)) + body))
        self.port.flush()
        header = _read_exact(self.port, 3)
        if header[0] != self.slave_id:
            raise OSError(f"Unexpected Modbus slave {header[0]}")
        if header[1] == function | 0x80:
            response = header + _read_exact(self.port, 2)
            self._validate(response)
            raise OSError(f"Modbus exception {header[2]}")
        if header[1] != function:
            raise OSError(f"Unexpected Modbus function {header[1]}")
        if function == 6:
            response = header + _read_exact(self.port, 5)
            self._validate(response)
            return response[2:-2]
        response = header + _read_exact(self.port, header[2] + 2)
        self._validate(response)
        return response[3:-2]

    @staticmethod
    def _validate(response: bytes) -> None:
        expected = struct.unpack("<H", response[-2:])[0]
        actual = crc16(response[:-2])
        if actual != expected:
            raise OSError(f"Modbus CRC mismatch: {actual:04x} != {expected:04x}")

    def read_registers(self, start: int, count: int, holding: bool = False) -> list[int]:
        data = self._request(3 if holding else 4, struct.pack(">HH", start, count))
        if len(data) != count * 2:
            raise OSError(f"Modbus returned {len(data) // 2} registers instead of {count}")
        return list(struct.unpack(f">{count}H", data))

    def write_register(self, address: int, value: int) -> None:
        body = struct.pack(">HH", address, value)
        response = self._request(6, body)
        if response != body:
            raise OSError("Modbus write echo mismatch")


class PollingModbusDriver(DeviceDriver):
    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.settings = SerialSettings.from_config(self.config)
        self.line: SerialLine = self.lines.line(self.settings)
        self.slave_id = int(self.config["slave_id"])
        if not 1 <= self.slave_id <= 247:
            raise ValueError("Modbus slave_id must be in 1..247")
        self.poll_interval = max(0.05, int(self.config.get("poll_interval_ms", 1000)) / 1000)
        self.retries = max(0, int(self.config.get("retries", 0)))
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self.state = DeviceState.RUNNING
        self.message = None
        self._task = asyncio.create_task(self._run(), name=f"modbus-{self.device_id}")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self.state = DeviceState.STOPPED

    async def _run(self) -> None:
        while True:
            try:
                await self.poll()
                self.message = None
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - один слейв не останавливает остальных
                self.message = str(error)
                self.emit(PeripheralEvent(
                    device_id=self.device_id,
                    kind="communication_error",
                    payload={"error": str(error)},
                ))
            await asyncio.sleep(self.poll_interval)

    async def exchange(self, operation):
        last_error: Exception | None = None
        for _ in range(self.retries + 1):
            try:
                return await self.line.exchange(
                    lambda port: operation(ModbusRtu(port, self.slave_id)),
                    timeout=self.settings.timeout,
                    request_gap=self.settings.request_gap,
                )
            except Exception as error:  # noqa: BLE001 - повтор транспорта
                last_error = error
        assert last_error is not None
        raise last_error

    @abstractmethod
    async def poll(self) -> None:
        raise NotImplementedError
