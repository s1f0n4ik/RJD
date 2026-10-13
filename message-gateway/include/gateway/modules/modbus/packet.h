#pragma once

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <string>
#include <vector>

namespace varan {
    namespace gateway {

        // Поле записи для страницы
        struct FPacketField {
            std::string label;
            int reg = 0;                // смещение первого регистра в записи
            int count = 1;              // регистров
            std::string kind;           // service | number | time | geo | detection | frame | reserved
            std::string value;
            std::string note;           // вторая строка значения
            std::string dict;           // словарь мастера, по которому расшифровывается значение
            bool brief = false;         // столбец таблицы записей
        };

        // Кодек пакета записи АС КРСПС: формат и состав; регистр 0 — длина, 1 — номер
        class AModbusPacket {
        public:
            virtual ~AModbusPacket() = default;

            // Номер пакета в каталоге АС КРСПС
            virtual std::uint16_t kind() const = 0;
            // Длина записи в регистрах, включая длину и номер
            virtual std::uint16_t length() const = 0;
            // Время записи UTC в регистры записи
            virtual void stamp(std::vector<std::uint16_t>& regs, std::int64_t utc_ms) const = 0;
            // Поля записи по порядку регистров
            virtual std::vector<FPacketField> describe(const std::vector<std::uint16_t>& regs) const = 0;

        protected:
            // Запись нужной длины с длиной в регистре 0
            std::vector<std::uint16_t> blank() const {
                std::vector<std::uint16_t> regs(length(), 0);
                regs[0] = length();
                return regs;
            }

            // Поля длины и номера
            static std::vector<FPacketField> header(const std::vector<std::uint16_t>& regs) {
                return {
                    { "Длина", 0, 1, "service", std::to_string(regs[0]) },
                    { "Номер", 1, 1, "number", std::to_string(regs[1]) },
                };
            }

            // unix-секунды в 4 регистра, младшие первыми
            static void put_unix(std::vector<std::uint16_t>& regs, std::size_t at, std::int64_t utc_ms) {
                const auto unix_s = static_cast<std::uint64_t>(utc_ms / 1000);
                for (std::size_t i = 0; i < 4; ++i) {
                    regs[at + i] = static_cast<std::uint16_t>(unix_s >> (16 * i));
                }
            }

            static std::int64_t get_unix(const std::vector<std::uint16_t>& regs, std::size_t at) {
                std::uint64_t v = 0;
                for (std::size_t i = 0; i < 4; ++i) {
                    v |= static_cast<std::uint64_t>(regs[at + i]) << (16 * i);
                }
                return static_cast<std::int64_t>(v);
            }

            // Градусы, минуты, десятитысячные доли минуты
            static void put_angle(std::vector<std::uint16_t>& regs, std::size_t at, double v) {
                const long long t = std::llround(std::fabs(v) * 600000.0);
                regs[at] = static_cast<std::uint16_t>(t / 600000);
                regs[at + 1] = static_cast<std::uint16_t>(t % 600000 / 10000);
                regs[at + 2] = static_cast<std::uint16_t>(t % 10000);
            }

            static std::string angle_text(const std::vector<std::uint16_t>& regs, std::size_t at) {
                char buf[48];
                std::snprintf(buf, sizeof(buf), "%u° %02u.%04u′", regs[at], regs[at + 1], regs[at + 2]);
                return buf;
            }

            // ЧЧ:ММ:СС и ДД.ММ.ГГГГ по UTC
            static std::string utc_text(std::int64_t unix_s, const char* format) {
                const std::time_t t = static_cast<std::time_t>(unix_s);
                std::tm tm{};
#if defined(_WIN32)
                gmtime_s(&tm, &t);
#else
                gmtime_r(&t, &tm);
#endif
                char buf[32];
                std::strftime(buf, sizeof(buf), format, &tm);
                return buf;
            }
        };

    } // namespace gateway
} // namespace varan
