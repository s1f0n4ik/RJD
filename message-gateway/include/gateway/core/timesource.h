#pragma once

#include <ctime>
#include <cstdio>
#include <string>
#include <mutex>
#include <cstdint>

#include <boost/json.hpp>

#include "gateway/utility/clock.h"
#include "gateway/core/message.h"

namespace varan {
    namespace gateway {

        // Точка входа времени и GPS для остальных сервисов. Источник — стороннее
        // устройство (Садко) на шине CAN: модуль CAN зовёт update_time/update_gps
        // на каждое его сообщение. Пока по шине ничего не пришло, отдаются
        // серверные часы и заглушка координат.
        //
        // Время от Садко приходит с точностью до секунды раз в 0,5 с. Хранить его
        // как есть нельзя — между сообщениями оно стояло бы на месте, и два кадра
        // подряд получили бы одну метку. Поэтому запоминаем момент приёма по
        // монотонным часам и при выдаче добавляем то, что натикало с тех пор:
        // время остаётся временем Садко, но идёт непрерывно.
        //
        // По шине время идёт в UTC; наружу снимок отдаётся уже сдвинутым на
        // настроенный пользователем пояс — потребители (media-center, панель)
        // используют его как есть и о поясах не думают.
        //
        // snapshot_struct() — единый источник данных; snapshot() (REST) и gRPC
        // GetTime форматируют один и тот же снимок под свой транспорт.
        class UTimeSource {
        public:
            // Координаты считаются достоверными, только пока сообщения идут:
            // Садко шлёт их раз в 0,5 с, так что двухсекундная тишина — это уже
            // потеря связи, а не пауза.
            static constexpr std::int64_t GPS_STALE_MS = 2000;

            void set_tz_offset_min(int minutes) {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_tz_offset_min = minutes;
            }

            int tz_offset_min() const {
                std::lock_guard<std::mutex> lock(m_mutex);
                return m_tz_offset_min;
            }

            void update_time(std::int64_t unix_ms) {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_can_unix_ms = unix_ms;
                m_can_time_mono = mono_ms();
                m_has_can_time = true;
            }

            void update_gps(double lat, double lon, double speed) {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_lat = lat;
                m_lon = lon;
                m_speed = speed;
                m_gps_mono = mono_ms();
                m_has_can_gps = true;
            }

            FTimeGpsSnapshot snapshot_struct() const {
                std::lock_guard<std::mutex> lock(m_mutex);

                FTimeGpsSnapshot s;
                const std::int64_t utc_ms = m_has_can_time
                    ? m_can_unix_ms + (mono_ms() - m_can_time_mono)
                    : now_ms();
                s.unix_ms = utc_ms + static_cast<std::int64_t>(m_tz_offset_min) * 60000;
                s.tz_offset_min = m_tz_offset_min;

                if (m_has_can_gps) {
                    s.lat = m_lat;
                    s.lon = m_lon;
                    s.speed = m_speed;
                    s.alt = 0.0;      // Садко высоту не передаёт
                    s.sats = 0;       // и число спутников тоже
                    s.course = 0.0;
                    s.valid = (mono_ms() - m_gps_mono) <= GPS_STALE_MS;
                }
                else {
                    s.lat = 55.7695;  // заглушка: район РЖД, Москва
                    s.lon = 37.6626;
                    s.alt = 150.0;
                    s.valid = true;
                    s.sats = 11;
                    s.speed = 0.0;
                    s.course = 0.0;
                }
                return s;
            }

            boost::json::object snapshot() const {
                const FTimeGpsSnapshot s = snapshot_struct();

                std::string time_src, gps_src;
                std::int64_t gps_age = -1;
                {
                    std::lock_guard<std::mutex> lock(m_mutex);
                    time_src = m_has_can_time ? "can" : "server";
                    gps_src = m_has_can_gps ? "can" : "static";
                    if (m_has_can_gps) {
                        gps_age = mono_ms() - m_gps_mono;
                    }
                }

                boost::json::object gps;
                gps["lat"] = s.lat;
                gps["lon"] = s.lon;
                gps["alt"] = s.alt;
                gps["valid"] = s.valid;
                gps["sats"] = s.sats;
                gps["speed"] = s.speed;
                gps["course"] = s.course;
                if (gps_age >= 0) {
                    gps["age_ms"] = gps_age;
                }

                boost::json::object source;
                source["time"] = time_src;
                source["gps"] = gps_src;

                boost::json::object o;
                o["unix_ms"] = s.unix_ms;
                o["unix_s"] = s.unix_ms / 1000;
                o["tz_offset_min"] = s.tz_offset_min;
                o["iso"] = iso_with_offset(s.unix_ms, s.tz_offset_min);
                o["gps"] = std::move(gps);
                o["source"] = std::move(source);
                return o;
            }

        private:
            // ms уже сдвинуты на пояс — форматируем gmtime и дописываем офсет
            static std::string iso_with_offset(std::int64_t ms, int tz_offset_min) {
                const std::time_t t = static_cast<std::time_t>(ms / 1000);
                std::tm tm{};
#if defined(_WIN32)
                gmtime_s(&tm, &t);
#else
                gmtime_r(&t, &tm);
#endif
                char buf[32];
                std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &tm);

                const int abs_min = tz_offset_min < 0 ? -tz_offset_min : tz_offset_min;
                char suffix[8];
                std::snprintf(suffix, sizeof(suffix), "%c%02d:%02d",
                    tz_offset_min < 0 ? '-' : '+', abs_min / 60, abs_min % 60);
                return std::string(buf) + suffix;
            }

        private:
            mutable std::mutex m_mutex;

            // Пояс выдачи, минуты от UTC. Дефолт — МСК; правится по REST
            int m_tz_offset_min = 180;

            bool m_has_can_time = false;
            std::int64_t m_can_unix_ms = 0;   // время из последнего сообщения Садко
            std::int64_t m_can_time_mono = 0; // монотонный момент его приёма

            bool m_has_can_gps = false;
            double m_lat = 0.0;
            double m_lon = 0.0;
            double m_speed = 0.0;
            std::int64_t m_gps_mono = 0;
        };

    } // namespace gateway
} // namespace varan
