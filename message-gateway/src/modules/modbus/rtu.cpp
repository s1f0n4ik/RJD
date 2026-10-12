#include "gateway/modules/modbus/rtu.h"

namespace varan {
    namespace gateway {

        std::uint16_t modbus_crc(const std::uint8_t* data, std::size_t n) {
            std::uint16_t crc = 0xFFFF;
            for (std::size_t i = 0; i < n; ++i) {
                crc ^= data[i];
                for (int b = 0; b < 8; ++b) {
                    crc = (crc & 1) ? static_cast<std::uint16_t>((crc >> 1) ^ 0xA001) : static_cast<std::uint16_t>(crc >> 1);
                }
            }
            return crc;
        }

        std::size_t request_length(const std::uint8_t* d, std::size_t n) {
            if (n < 2) {
                return modbus::NEED_MORE;
            }
            switch (d[1]) {
            case 0x01: case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x08:
                return 8;
            case 0x07: case 0x0B: case 0x0C: case 0x11:
                return 4;
            case 0x16:
                return 10;
            case 0x0F: case 0x10:
                return n < 7 ? modbus::NEED_MORE : 9 + static_cast<std::size_t>(d[6]);
            case 0x17:
                return n < 11 ? modbus::NEED_MORE : 13 + static_cast<std::size_t>(d[10]);
            default:
                return modbus::UNKNOWN;
            }
        }

        std::size_t response_length(const std::uint8_t* d, std::size_t n) {
            if (n < 2) {
                return modbus::NEED_MORE;
            }
            if (d[1] & 0x80) {
                return 5;
            }
            switch (d[1]) {
            case 0x01: case 0x02: case 0x03: case 0x04:
                return n < 3 ? modbus::NEED_MORE : 5 + static_cast<std::size_t>(d[2]);
            case 0x05: case 0x06: case 0x0F: case 0x10:
                return 8;
            default:
                return modbus::UNKNOWN;
            }
        }

    } // namespace gateway
} // namespace varan
