#pragma once

#include <ctime>
#include <cstdint>

#include <boost/json.hpp>

#include "gateway/rsm2000-integration.h"  // now_ms()
#include "gateway/message.h"              // FTimeGpsSnapshot

namespace varan {
    namespace gateway {

        // Точка входа времени и GPS для остальных сервисов. Пока время берётся
        // серверное (системные часы шлюза), GPS захардкожен. Позже здесь появится
        // реальный источник (приёмник GNSS / модем). Контракт наружу не меняется.
        // snapshot_struct() — единый источник данных; snapshot() (REST) и gRPC
        // GetTime форматируют один и тот же снимок под свой транспорт.
        class UTimeSource {
        public:
            FTimeGpsSnapshot snapshot_struct() const {
                FTimeGpsSnapshot s;
                s.unix_ms = now_ms();
                s.lat = 55.7695;      // хардкод: район РЖД, Москва
                s.lon = 37.6626;
                s.alt = 150.0;
                s.valid = true;
                s.sats = 11;
                s.speed = 0.0;        // м/с
                s.course = 0.0;       // градусы
                return s;
            }

            boost::json::object snapshot() const {
                const FTimeGpsSnapshot s = snapshot_struct();

                boost::json::object gps;
                gps["lat"] = s.lat;
                gps["lon"] = s.lon;
                gps["alt"] = s.alt;
                gps["valid"] = s.valid;
                gps["sats"] = s.sats;
                gps["speed"] = s.speed;
                gps["course"] = s.course;

                boost::json::object source;
                source["time"] = "server"; // серверные часы шлюза
                source["gps"] = "static";  // фиксированные координаты (заглушка)

                boost::json::object o;
                o["unix_ms"] = s.unix_ms;
                o["unix_s"] = s.unix_ms / 1000;
                o["iso"] = iso_utc(s.unix_ms);
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
