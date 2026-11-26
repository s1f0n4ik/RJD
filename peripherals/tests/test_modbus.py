import struct

import pytest
from app.devices.modbus import ModbusRtu, crc16, frame


class FakeSerial:
    def __init__(self, response: bytes):
        self.response = bytearray(response)
        self.written = b""

    def reset_input_buffer(self):
        pass

    def write(self, data):
        self.written += data

    def flush(self):
        pass

    def read(self, size):
        part = self.response[:size]
        del self.response[:size]
        return bytes(part)


def test_crc_matches_modbus_reference_frame():
    assert crc16(bytes.fromhex("01030000000A")) == 0xCDC5


def test_read_input_registers_and_request_frame():
    payload = bytes((12, 4, 4)) + struct.pack(">HH", 20, 25)
    port = FakeSerial(frame(payload))
    client = ModbusRtu(port, 12)
    assert client.read_registers(999, 2) == [20, 25]
    assert port.written == frame(bytes((12, 4)) + struct.pack(">HH", 999, 2))


def test_crc_error_is_rejected():
    payload = frame(bytes((1, 4, 2, 0, 1)))
    port = FakeSerial(payload[:-1] + bytes((payload[-1] ^ 0xFF,)))
    with pytest.raises(OSError, match="CRC"):
        ModbusRtu(port, 1).read_registers(0, 1)


def test_write_single_register_checks_echo():
    body = struct.pack(">HH", 0x1FFF, 0x8000)
    port = FakeSerial(frame(bytes((1, 6)) + body))
    ModbusRtu(port, 1).write_register(0x1FFF, 0x8000)
    assert port.written == frame(bytes((1, 6)) + body)
