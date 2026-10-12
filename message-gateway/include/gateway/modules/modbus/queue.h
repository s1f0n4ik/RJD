#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace varan {
    namespace gateway {

        // Запись очереди АС КРСПС: регистры целиком, номер — в регистре 1
        struct FModbusRecord {
            std::uint16_t number = 0;
            bool hidden = false;            // до первого времени от АС КРСПС
            std::int64_t utc_ms = 0;        // у скрытой — по часам платы
            std::uint16_t packet = 0;       // номер пакета в каталоге АС КРСПС
            std::vector<std::uint16_t> regs;
        };

        // Очередь записей для АС КРСПС: номера 0–65535 по кругу, видимые с головы, скрытые хвостом до первого времени
        // Окно — столько видимых записей с головы, сколько целиком помещается в WINDOW регистров
        // Каждая правка уходит в файл фоновым писателем: временный файл, fsync, rename
        class UModbusQueue {
        public:
            static constexpr std::size_t CAPACITY = 65535;
            static constexpr std::size_t RECENT = 20;
            static constexpr std::size_t WINDOW = 0x1000;

            // Итог команды отметки
            struct FMarkResult {
                bool ok = false;
                int removed = 0;
                std::uint16_t head = 0;     // номер первой видимой до отметки
            };

            struct FRecent {
                FModbusRecord r;
                std::string status;         // hidden | queued | read | dropped
            };

            struct FSnapshot {
                std::size_t total = 0;
                std::size_t visible = 0;
                std::size_t hidden = 0;
                std::size_t window = 0;     // записей в окне
                std::int64_t dropped = 0;
                std::uint16_t next = 0;
                std::vector<FRecent> recent;    // от свежих к старым
                std::optional<FModbusRecord> head;
            };

            // Пересчёт регистров записи после смены её времени
            using CRestamp = std::function<void(FModbusRecord&)>;

            // Пустой путь — без файла
            explicit UModbusQueue(std::string path);
            ~UModbusQueue();

            // Номер новой записи, он же в регистре 1; полная очередь выкидывает старейшую
            std::uint16_t push(FModbusRecord r);
            // Скрытые становятся видимыми со сдвигом времени; возвращает их число
            int reveal(std::int64_t offset_ms, const CRestamp& restamp);
            // Снимает с головы first..last, если номера совпали с записями окна
            FMarkResult mark(std::uint16_t first, std::uint16_t last);

            // Видимых записей, значение 0x1006
            std::uint16_t visible() const;
            // Все записи очереди длины length; пустая очередь — true
            bool uniform(std::size_t length) const;
            // Регистры окна с offset от его начала; возвращает номера задетых записей
            std::vector<std::uint16_t> window(std::size_t offset, std::size_t count, std::uint16_t* out) const;

            FSnapshot snapshot() const;

        private:
            void load();
            void touch_locked();
            void writer_loop();
            std::string serialize_locked() const;
            void set_recent_locked(std::uint16_t number, const char* status);
            std::size_t window_records_locked() const;

        private:
            std::string m_path;
            mutable std::mutex m_mutex;
            std::deque<FModbusRecord> m_records;
            std::size_t m_hidden = 0;
            std::uint16_t m_next = 1;
            std::int64_t m_dropped = 0;
            std::deque<FRecent> m_recent;

            std::condition_variable m_cv;
            bool m_dirty = false;
            bool m_stop = false;
            std::thread m_writer;
        };

    } // namespace gateway
} // namespace varan
