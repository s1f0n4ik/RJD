#include "gateway/modules/can/codec.h"

#include <ctime>
#include <cmath>
#include <algorithm>

namespace varan {
    namespace gateway {

        namespace {

            // Байты 3-4 и 7-8 идут Intel-порядком (вперёд младшим байтом).
            std::uint16_t read_u16_le(const FCanFrame& f, std::size_t pos) {
                return static_cast<std::uint16_t>(f.data[pos]) |
                    (static_cast<std::uint16_t>(f.data[pos + 1]) << 8);
            }

            // timegm нестандартна: под Windows это _mkgmtime. Локальную mktime брать
            // нельзя — время в сообщении UTC, и на машине с не-UTC зоной оно
            // уехало бы на смещение зоны.
            std::time_t to_utc(std::tm& tm) {
#if defined(_WIN32)
                return _mkgmtime(&tm);
#else
                return ::timegm(&tm);
#endif
            }

        } // namespace

        std::uint32_t make_j1939_id(int priority, int pgn, int src, int dst) {
            const std::uint32_t dp = static_cast<std::uint32_t>((pgn >> 16) & 0x03);
            const std::uint32_t pf = static_cast<std::uint32_t>((pgn >> 8) & 0xFF);
            // PDU2 — широковещательное, младший байт PGN сам является PS.
            const std::uint32_t ps = (pf >= 0xF0)
                ? static_cast<std::uint32_t>(pgn & 0xFF)
                : static_cast<std::uint32_t>(dst & 0xFF);

            return ((static_cast<std::uint32_t>(priority) & 0x07) << 26)
                | (dp << 24)
                | (pf << 16)
                | (ps << 8)
                | (static_cast<std::uint32_t>(src) & 0xFF);
        }

        FJ1939Id parse_j1939_id(std::uint32_t id) {
            FJ1939Id out;
            const int dp = static_cast<int>((id >> 24) & 0x03);
            const int pf = static_cast<int>((id >> 16) & 0xFF);
            const int ps = static_cast<int>((id >> 8) & 0xFF);

            out.priority = static_cast<int>((id >> 26) & 0x07);
            out.src = static_cast<int>(id & 0xFF);
            out.dst = (pf >= 0xF0) ? 0xFF : ps;  // у PDU2 получателя нет
            out.pgn = (pf >= 0xF0)
                ? ((dp << 16) | (pf << 8) | ps)
                : ((dp << 16) | (pf << 8));
            return out;
        }

        FCanFrame encode_detection_frame(const FCanDetectionPayload& p, int priority,
            int pgn, int src, int dst, int dlc) {
            FCanFrame f;
            f.id = make_j1939_id(priority, pgn, src, dst);
            f.extended = true;
            f.dlc = static_cast<std::uint8_t>(std::clamp(dlc, 4, 8));

            f.data.fill(0xFF);
            f.data[0] = static_cast<std::uint8_t>(std::clamp(p.count, 0, 255));
            f.data[1] = static_cast<std::uint8_t>(std::clamp(p.type, 0, 255));
            f.data[2] = static_cast<std::uint8_t>(std::clamp(p.danger, 0, 255));
            f.data[3] = static_cast<std::uint8_t>(p.camera_mask & 0xFF);
            return f;
        }

        bool decode_gps_frame(const FCanFrame& f, FCanGps& out, std::string& err) {
            if (f.dlc < 8) {
                err = "gps frame: expected 8 bytes, got " + std::to_string(f.dlc);
                return false;
            }

            const int lat_deg = f.data[0];
            const int lat_min = f.data[1] & 0x3F;   // биты 2.1-2.6
            const bool north = (f.data[1] & 0x40) != 0;  // бит 2.7
            const bool south = (f.data[1] & 0x80) != 0;  // бит 2.8
            const std::uint16_t lat_sec = read_u16_le(f, 2);

            const int lon_deg = f.data[4];
            const int lon_min = f.data[5] & 0x3F;   // биты 6.1-6.6
            const bool east = (f.data[5] & 0x40) != 0;   // бит 6.7
            const bool west = (f.data[5] & 0x80) != 0;   // бит 6.8
            const std::uint16_t lon_sec = read_u16_le(f, 6);

            // Ровно один бит знака должен стоять. Оба или ни одного — устройство
            // ещё не поймало фикс либо кадр битый: принимать нельзя, иначе
            // координата уедет в другое полушарие.
            if (north == south) {
                err = "gps frame: latitude sign is ambiguous (N and S both "
                    + std::string(north ? "set" : "clear") + ")";
                return false;
            }
            if (east == west) {
                err = "gps frame: longitude sign is ambiguous (E and W both "
                    + std::string(east ? "set" : "clear") + ")";
                return false;
            }

            if (lat_deg > 90) {
                err = "gps frame: latitude degrees out of range: " + std::to_string(lat_deg);
                return false;
            }
            if (lon_deg > 180) {
                err = "gps frame: longitude degrees out of range: " + std::to_string(lon_deg);
                return false;
            }
            if (lat_min > 59 || lon_min > 59) {
                err = "gps frame: minutes out of range";
                return false;
            }
            if (lat_sec > 60000 || lon_sec > 60000) {
                err = "gps frame: seconds out of range";
                return false;
            }

            out.lat = lat_deg + lat_min / 60.0 + (lat_sec / 1000.0) / 3600.0;
            out.lon = lon_deg + lon_min / 60.0 + (lon_sec / 1000.0) / 3600.0;
            if (south) out.lat = -out.lat;
            if (west)  out.lon = -out.lon;
            return true;
        }

        bool decode_time_frame(const FCanFrame& f, FCanTime& out, std::string& err) {
            if (f.dlc < 8) {
                err = "time frame: expected 8 bytes, got " + std::to_string(f.dlc);
                return false;
            }

            const int year = f.data[0];   // две последние цифры, пример: 25
            const int month = f.data[1];
            const int day = f.data[2];
            const int hour = f.data[3];
            const int minute = f.data[4];
            const int second = f.data[5];

            if (month < 1 || month > 12 || day < 1 || day > 31 ||
                hour > 23 || minute > 59 || second > 60 || year > 99) {
                err = "time frame: invalid date/time "
                    + std::to_string(day) + "." + std::to_string(month) + "." + std::to_string(year)
                    + " " + std::to_string(hour) + ":" + std::to_string(minute) + ":" + std::to_string(second);
                return false;
            }

            std::tm tm{};
            tm.tm_year = 2000 + year - 1900;
            tm.tm_mon = month - 1;
            tm.tm_mday = day;
            tm.tm_hour = hour;
            tm.tm_min = minute;
            tm.tm_sec = second;
            tm.tm_isdst = 0;

            const std::time_t t = to_utc(tm);
            if (t == static_cast<std::time_t>(-1)) {
                err = "time frame: date is not representable";
                return false;
            }

            out.unix_ms = static_cast<std::int64_t>(t) * 1000;
            out.speed = read_u16_le(f, 6) * 0.01;  // 0.01 м/с на бит
            return true;
        }

    } // namespace gateway
} // namespace varan
