#pragma once

#include <string>
#include <deque>
#include <mutex>
#include <atomic>
#include <cstdint>

#include <boost/json.hpp>

namespace varan {
    namespace gateway {

        // Одна запись об отправленном (или отклонённом) сообщении. Кольцо таких
        // записей показывается на странице как "последние сообщения".
        struct FMessageRecord {
            std::int64_t seq = 0;         // сквозной номер записи в шлюзе
            std::int64_t id = 0;          // id кадра из сообщения
            std::int64_t ts_recv_ms = 0;  // серверное время приёма кадра
            int ver = 0;                  // версия протокола сообщения
            int detections = 0;           // число обнаружений в кадре
            std::int64_t wire_size = 0;   // размер отправленных байт
            std::string kind;             // "frame" | "heartbeat"
            std::string status;           // "sent" | "rejected"
            std::string error;            // текст ошибки при rejected
        };

        // Счётчики работы одной интеграции плюс кольцо последних сообщений.
        // Потокобезопасна: счётчики атомарные, кольцо под мьютексом.
        class UStats {
        public:
            explicit UStats(std::size_t ring_capacity = 25)
                : m_capacity(ring_capacity)
            {}

            // Кадр успешно закодирован и отдан в транспорт.
            void on_frame_sent(std::int64_t id, std::int64_t ts_recv_ms, int ver,
                int detections, std::int64_t wire_size, bool had_image) {
                m_messages.fetch_add(1);
                m_detections.fetch_add(detections);
                m_bytes.fetch_add(wire_size);
                if (had_image) {
                    m_images.fetch_add(1);
                }
                push(FMessageRecord{
                    next_seq(), id, ts_recv_ms, ver, detections, wire_size,
                    "frame", "sent", "" });
            }

            // Повторная выдача той же нагрузки: CAN шлёт кадр каждые 100 мс, даже
            // когда обнаружения не менялись. Учитываем только в счётчиках — в ленту
            // такие кадры не кладём, иначе на десяти кадрах в секунду она станет
            // нечитаемой и вытеснит всё осмысленное.
            void on_frame_repeated(std::int64_t wire_size) {
                m_messages.fetch_add(1);
                m_bytes.fetch_add(wire_size);
                m_repeats.fetch_add(1);
            }

            // Служебный heartbeat отправлен в транспорт.
            void on_heartbeat_sent(std::int64_t ts_recv_ms, int ver, std::int64_t wire_size) {
                m_messages.fetch_add(1);
                m_bytes.fetch_add(wire_size);
                m_heartbeats.fetch_add(1);
                push(FMessageRecord{
                    next_seq(), 0, ts_recv_ms, ver, 0, wire_size,
                    "heartbeat", "sent", "" });
            }

            // Кадр отклонён (нет кодека, ошибка кодирования, нет соединения).
            void on_frame_rejected(std::int64_t id, std::int64_t ts_recv_ms, int ver,
                int detections, const std::string& error) {
                m_rejected.fetch_add(1);
                push(FMessageRecord{
                    next_seq(), id, ts_recv_ms, ver, detections, 0,
                    "frame", "rejected", error });
            }

            boost::json::object to_json() const {
                boost::json::object o;
                o["messages"] = m_messages.load();
                o["detections"] = m_detections.load();
                o["images"] = m_images.load();
                o["bytes"] = m_bytes.load();
                o["heartbeats"] = m_heartbeats.load();
                o["repeats"] = m_repeats.load();
                o["rejected"] = m_rejected.load();

                boost::json::array recent;
                {
                    std::lock_guard<std::mutex> lock(m_mutex);
                    recent.reserve(m_ring.size());
                    // Новые сверху.
                    for (auto it = m_ring.rbegin(); it != m_ring.rend(); ++it) {
                        recent.push_back(record_json(*it));
                    }
                }
                o["recent"] = std::move(recent);
                return o;
            }

        private:
            std::int64_t next_seq() {
                return m_seq.fetch_add(1) + 1;
            }

            void push(FMessageRecord rec) {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_ring.push_back(std::move(rec));
                if (m_ring.size() > m_capacity) {
                    m_ring.pop_front();
                }
            }

            static boost::json::object record_json(const FMessageRecord& r) {
                boost::json::object o;
                o["seq"] = r.seq;
                o["id"] = r.id;
                o["ts"] = r.ts_recv_ms;
                o["ver"] = r.ver;
                o["detections"] = r.detections;
                o["wire_size"] = r.wire_size;
                o["kind"] = r.kind;
                o["status"] = r.status;
                if (!r.error.empty()) {
                    o["error"] = r.error;
                }
                return o;
            }

        private:
            std::size_t m_capacity;

            std::atomic<std::int64_t> m_messages{ 0 };
            std::atomic<std::int64_t> m_detections{ 0 };
            std::atomic<std::int64_t> m_images{ 0 };
            std::atomic<std::int64_t> m_bytes{ 0 };
            std::atomic<std::int64_t> m_heartbeats{ 0 };
            std::atomic<std::int64_t> m_repeats{ 0 };
            std::atomic<std::int64_t> m_rejected{ 0 };
            std::atomic<std::int64_t> m_seq{ 0 };

            mutable std::mutex m_mutex;
            std::deque<FMessageRecord> m_ring;
        };

    } // namespace gateway
} // namespace varan
