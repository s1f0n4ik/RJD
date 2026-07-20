#pragma once

#include <deque>
#include <mutex>
#include <thread>
#include <condition_variable>
#include <atomic>
#include <filesystem>

#include "journal/types.h"
#include "logger.h"

// Тип sqlite3 из C-API. Не тянем sqlite3.h в заголовок — деталь реализации
// живёт в writer.cpp.
struct sqlite3;

namespace varan {
namespace journal {

    // Асинхронная запись журнала обнаружений в SQLite. Один writer на весь
    // процесс, общий для всех слотов. Пишет строки в фоновом потоке, чтобы не
    // трогать SQLite на потоке инференса. Режим WAL — чтобы storage-service мог
    // читать базу параллельно с записью. Файлы кадров пишет сам слот; writer
    // сохраняет только их пути и метаданные.
    class UJournalWriter {
    public:
        // db_path    — файл SQLite (например /storage/journal/journal.db).
        // frames_dir — корень для JPEG (например /storage/journal/frames); слот
        //              берёт его из ручки FSlotJournal и раскладывает по дате.
        UJournalWriter(std::filesystem::path db_path,
                       std::filesystem::path frames_dir,
                       ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG);
        ~UJournalWriter();

        UJournalWriter(const UJournalWriter&) = delete;
        UJournalWriter& operator=(const UJournalWriter&) = delete;

        // Открыть базу, создать схему и запустить фоновый поток. false — журнал
        // не поднялся; sink() остаётся безопасным (записи молча отбрасываются).
        bool start();
        void stop();

        // Поставить запись в очередь. Неблокирующе и потокобезопасно. При
        // переполнении очереди самая старая запись отбрасывается — журнал не
        // должен копить память при затыке диска.
        void enqueue(FEntry entry);

        // Ручка журналирования для слота (корень кадров + sink).
        FSlotJournal slot_journal();

        const std::filesystem::path& frames_dir() const { return m_frames_dir; }

    private:
        void worker();
        bool ensure_schema();
        bool write_entry(const FEntry& e);

        std::filesystem::path m_db_path;
        std::filesystem::path m_frames_dir;
        ULogger m_logger;

        sqlite3* m_db = nullptr;

        std::deque<FEntry> m_queue;
        std::mutex m_mutex;
        std::condition_variable m_cv;
        std::thread m_thread;
        std::atomic<bool> m_running{ false };

        static constexpr std::size_t kMaxQueue = 256;
    };

} // namespace journal
} // namespace varan
