#pragma once

#include <ctime>
#include <cstdint>

#include <boost/json.hpp>

#include "gateway/rsm2000-integration.h"  // now_ms()

namespace varan {
    namespace gateway {

        // Точка входа времени и GPS для остальных сервисов. Пока время берётся
        // серверное (системные часы шлюза), GPS захардкожен. Позже здесь появится
        // реальный источник (приёмник GNSS / модем). Контракт наружу не меняется.
        class UTimeSource {
        public:
            boost::json::object snapshot() const {
                const std::int64_t ms = now_ms();

                boost::json::object gps;
                gps["lat"] = 55.7695;      // хардкод: район РЖД, Москва
                gps["lon"] = 37.6626;
                gps["alt"] = 150.0;
                gps["valid"] = true;
                gps["sats"] = 11;
                gps["speed"] = 0.0;        // м/с
                gps["course"] = 0.0;       // градусы

                boost::json::object source;
                source["time"] = "server"; // серверные часы шлюза
                source["gps"] = "static";  // фиксированные координаты (заглушка)

                boost::json::object o;
                o["unix_ms"] = ms;
                o["unix_s"] = ms / 1000;
                o["iso"] = iso_utc(ms);
                o["gps"] = std::move(gps);
                o["source"] = std::move(source);
                return o;
            }

        private:
            static std::string iso_utc(std::int64_t ms) {
                const std::time_t t = static_cast<std::time_t>(ms / 1000);
                std::tm tm{};
#if defined(_WIN32)
                gmtime_s(&tm, &t);
#else
                gmtime_r(&t, &tm);
#endif
                char buf[32];
                std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
                return std::string(buf);
            }
        };

    } // namespace gateway
} // namespace varan
