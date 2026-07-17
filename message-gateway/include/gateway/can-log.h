#pragma once

#include <string>
#include <array>
#include <deque>
#include <vector>
#include <mutex>
#include <atomic>
#include <cstdint>

#include <boost/json.hpp>

#include "gateway/can-bus.h"

namespace varan {
    namespace gateway {

        // Журнал шины: каждый кадр, ушедший или принятый, с полным id и байтами.
        // Отдельно от UStats — та считает кадры media-center и меряет их в
        // байтах изображения, здесь же нужны сами восемь байт и расшифровка.
        //
        // Пишем все кадры подряд, включая повторы: на шине 10 кадров/с в
        // передаче и 4 кадра/с в приёме, кольца на 250 записей хватает примерно
        // на 18 секунд истории — этого достаточно, чтобы поймать глазами момент.
        class UCanLog {
        public:
            struct FRecord {
                std::int64_t seq = 0;
                std::int64_t ts_ms = 0;
                bool tx = false;
                std::uint32_t id = 0;
                std::uint8_t dlc = 0;
                std::array<std::uint8_t, 8> data{};
                std::string note;   // расшифровка: что кадр значит
                std::string error;  // непусто -> кадр не разобрался
            };

            // Текущее состояние одного типа сообщения — сводка над лентой.
            // По ней видно, какое сообщение замолчало: у живого возраст свежий.
            struct FSummary {
                std::string key;     // "tx_detections" | "rx_gps" | "rx_time"
                std::string title;
                bool tx = false;
                bool enabled = true;
                std::uint32_t id = 0;
                std::int64_t count = 0;
                std::int64_t errors = 0;
                std::int64_t last_mono = 0;  // 0 — кадров ещё не было
                std::uint8_t dlc = 0;
                std::array<std::uint8_t, 8> data{};
                std::string note;
            };

            explicit UCanLog(std::size_t capacity = 250)
                : m_capacity(capacity)
            {}

            void push(const FCanFrame& f, bool tx, std::int64_t ts_ms,
                std::string note, std::string error);

            boost::json::array to_json() const;

            // Байты кадра как "02 01 04 01 FF FF FF FF".
            static std::string hex_data(const std::array<std::uint8_t, 8>& data, std::uint8_t dlc);
            static std::string hex_id(std::uint32_t id);

            static boost::json::object summary_json(const FSummary& s);

        private:
            std::size_t m_capacity;
            std::atomic<std::int64_t> m_seq{ 0 };
            mutable std::mutex m_mutex;
            std::deque<FRecord> m_ring;
        };

    } // namespace gateway
} // namespace varan
