#pragma once

#include <cstddef>
#include <cstdint>

namespace varan {
    namespace gateway {

        // Modbus RTU: коды функций и исключений, размеры кадров
        namespace modbus {
            constexpr std::size_t MAX_ADU = 256;

            constexpr std::uint8_t FC_READ_INPUT = 0x04;
            constexpr std::uint8_t FC_WRITE_SINGLE = 0x06;
            constexpr std::uint8_t FC_WRITE_MULTIPLE = 0x10;

            constexpr std::uint8_t EX_ILLEGAL_FUNCTION = 0x01;
            constexpr std::uint8_t EX_ILLEGAL_ADDRESS = 0x02;
            constexpr std::uint8_t EX_ILLEGAL_VALUE = 0x03;

            // Длина кадра не определяется: код неизвестен
            constexpr std::size_t UNKNOWN = 0;
            // Для подсчёта длины не хватает байт
            constexpr std::size_t NEED_MORE = static_cast<std::size_t>(-1);
        }

        // CRC16 Modbus: полином 0xA001, начальное 0xFFFF
        std::uint16_t modbus_crc(const std::uint8_t* data, std::size_t n);

        // Длина запроса ведущего по коду функции
        std::size_t request_length(const std::uint8_t* data, std::size_t n);
        // Длина ответа ведомого по коду функции
        std::size_t response_length(const std::uint8_t* data, std::size_t n);

    } // namespace gateway
} // namespace varan
