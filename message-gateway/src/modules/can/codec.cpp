#include "gateway/modules/can/codec.h"

#include <ctime>
#include <cmath>
#include <cstdio>
#include <atomic>
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

            // Окно правдоподобности года. Всё за его пределами — битый кадр или
            // чужая раскладка: время отсюда уходит в имена файлов записи и в
            // журнал, откуда его уже не вычистить.
            constexpr int TIME_MIN_YEAR = 2025;
            constexpr int TIME_MAX_YEAR = 2050;

            struct FCalendar {
                int year = 0;
                int month = 0;
                int day = 0;
                int hour = 0;
                int minute = 0;
                int second = 0;
            };

            // Раскладка по описанию Садко: год двумя последними цифрами.
            FCalendar read_direct(const FCanFrame& f) {
                FCalendar c;
                c.year = 2000 + f.data[0];
                c.month = f.data[1];
                c.day = f.data[2];
                c.hour = f.data[3];
                c.minute = f.data[4];
                c.second = f.data[5];
                return c;
            }

            // Раскладка J1939: секунды и сутки идут по 0.25 на бит, год от 1985.
            FCalendar read_j1939(const FCanFrame& f) {
                FCalendar c;
                c.year = 1985 + f.data[5];
                c.month = f.data[3];
                c.day = f.data[4] / 4;
                c.hour = f.data[2];
                c.minute = f.data[1];
                c.second = f.data[0] / 4;
                return c;
            }

            bool calendar_valid(const FCalendar& c) {
                return c.year >= TIME_MIN_YEAR && c.year <= TIME_MAX_YEAR
                    && c.month >= 1 && c.month <= 12
                    && c.day >= 1 && c.day <= 31
                    && c.hour <= 23 && c.minute <= 59 && c.second <= 60;
            }

            std::string describe(const FCalendar& c) {
                char buf[32];
                std::snprintf(buf, sizeof(buf), "%02d.%02d.%04d %02d:%02d:%02d",
                    c.day, c.month, c.year, c.hour, c.minute, c.second);
                return buf;
            }

            bool to_unix_ms(const FCalendar& c, std::int64_t& out) {
                std::tm tm{};
                tm.tm_year = c.year - 1900;
                tm.tm_mon = c.month - 1;
                tm.tm_mday = c.day;
                tm.tm_hour = c.hour;
                tm.tm_min = c.minute;
                tm.tm_sec = c.second;
                tm.tm_isdst = 0;

                const std::time_t t = to_utc(tm);
                if (t == static_cast<std::time_t>(-1)) {
                    return false;
                }
                out = static_cast<std::int64_t>(t) * 1000;
                return true;
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

            const FCalendar direct = read_direct(f);
            const FCalendar j1939 = read_j1939(f);
            const bool direct_ok = calendar_valid(direct);
            const bool j1939_ok = calendar_valid(j1939);

            if (!direct_ok && !j1939_ok) {
                err = "time frame: no layout fits (direct " + describe(direct)
                    + ", j1939 " + describe(j1939) + ")";
                return false;
            }

            // Раскладка у устройства одна и на ходу не меняется: первый
            // однозначно опознанный кадр решает и за спорные, где годятся обе.
            static std::atomic<int> known_layout{ -1 };

            ECanTimeLayout layout;
            if (direct_ok != j1939_ok) {
                layout = direct_ok ? ECanTimeLayout::DIRECT : ECanTimeLayout::J1939;
                known_layout.store(static_cast<int>(layout));
            }
            else {
                const int known = known_layout.load();
                layout = known < 0
                    ? ECanTimeLayout::DIRECT
                    : static_cast<ECanTimeLayout>(known);
            }

            const FCalendar& c = layout == ECanTimeLayout::J1939 ? j1939 : direct;

            std::int64_t unix_ms = 0;
            if (!to_unix_ms(c, unix_ms)) {
                err = "time frame: date is not representable: " + describe(c);
                return false;
            }

            out.unix_ms = unix_ms;
            out.speed = read_u16_le(f, 6) * 0.01;  // 0.01 м/с на бит
            out.layout = layout;
            return true;
        }

    } // namespace gateway
} // namespace varan
