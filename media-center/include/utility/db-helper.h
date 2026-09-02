#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

#include "logger.h"

struct sqlite3;
struct sqlite3_stmt;

namespace varan {
namespace db {

    // Хелпер для реализации писателей в БД

    class UConnection {
    public:
        explicit UConnection(ULogger& logger) : m_logger(logger) {}
        ~UConnection() { close(); }

        UConnection(const UConnection&) = delete;
        UConnection& operator=(const UConnection&) = delete;

        // Создает каталог базы, осуществляет проверку на запись
        bool open(const std::filesystem::path& db_path);
        void close();

        bool is_open() const { return m_db != nullptr; }
        sqlite3* handle() const { return m_db; }
        const std::filesystem::path& path() const { return m_path; }

        // Команда в sql, what - если есть ошибка
        bool exec(const char* sql, const char* what);

        bool column_exists(const char* table, const char* column) const;
        void add_column(const char* table, const char* column, const char* decl);

        std::int64_t row_count(const char* table) const;
        std::int64_t last_insert_rowid() const;
        std::string error() const;

    private:
        ULogger& m_logger;
        sqlite3* m_db = nullptr;
        std::filesystem::path m_path;
    };

    // Транзакция BEGIN IMMEDIATE, без commit() откатывается в деструкторе
    class UTransaction {
    public:
        explicit UTransaction(UConnection& conn);
        ~UTransaction();

        UTransaction(const UTransaction&) = delete;
        UTransaction& operator=(const UTransaction&) = delete;

        bool commit();

    private:
        UConnection& m_conn;
        bool m_active = false;
    };

    // Подготовленный запрос: prepare в конструкторе, finalize в деструкторе
    // Параметры привязываются по порядку, номера считает сам.
    class UStatement {
    public:
        UStatement(UConnection& conn, const char* sql);
        ~UStatement();

        UStatement(const UStatement&) = delete;
        UStatement& operator=(const UStatement&) = delete;

        bool ok() const { return m_stmt != nullptr; }

        UStatement& bind(std::int64_t value);
        UStatement& bind(int value);
        UStatement& bind(double value);
        UStatement& bind(bool value);
        UStatement& bind(const std::string& value);
        // Пустая строка - это NULL, а не пустое значение, чтобы избежать путаницы для читателя
        UStatement& bind_text_or_null(const std::string& value);
        UStatement& bind_null();

        bool step_done();
        bool step_row();
        void reset();

        std::int64_t column_int64(int index) const;
        std::string column_text(int index) const;

    private:
        UConnection& m_conn;
        sqlite3_stmt* m_stmt = nullptr;
        int m_index = 1;
    };

    // Асинхронный писатель в бд, держит неблокирующую очередь
    // Базовый класс, ему нужен потомок
    template <typename TEntry>
    class AAsyncWriter {
    public:
        AAsyncWriter(std::filesystem::path db_path,
                     std::string name,
                     ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG)
            : m_db_path(std::move(db_path))
            , m_logger(std::move(name), level)
            , m_conn(m_logger)
        {
        }

        virtual ~AAsyncWriter() { stop(); }

        AAsyncWriter(const AAsyncWriter&) = delete;
        AAsyncWriter& operator=(const AAsyncWriter&) = delete;
        
        // Подключение к БД, загрузка схемы, если пустая, запуск потока для записи
        bool start() {
            if (m_running.load()) return true;

            if (!prepare()) return false;
            if (!m_conn.open(m_db_path)) return false;

            if (!ensure_schema()) {
                m_conn.close();
                return false;
            }

            m_running.store(true);
            m_thread = std::thread(&AAsyncWriter::worker, this);
            on_started();
            return true;
        }

        void stop() {
            if (m_running.exchange(false)) {
                m_cv.notify_all();
                if (m_thread.joinable()) m_thread.join();
                // Поток уже стоит, база еще открыта - последний шанс дописать
                if (m_conn.is_open()) on_stopping();
            }
            m_conn.close();
        }

        bool running() const { return m_running.load(); }

        // Реализации очереди, переполнена - уходит самая старая запись
        void enqueue(TEntry entry) {
            bool dropped = false;
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                if (m_queue.size() >= kMaxQueue) {
                    m_queue.pop_front();
                    dropped = true;
                }
                m_queue.push_back(std::move(entry));
            }
            if (dropped) m_logger.warn("sql queue overflow, oldest row dropped");
            m_cv.notify_one();
        }

    protected:
        // Что нужно наследнику до открытия базы — например, свой каталог.
        virtual bool prepare() { return true; }
        virtual bool ensure_schema() = 0;
        virtual bool write_one(const TEntry& entry) = 0;
        // Зовётся после старта потока — писателю есть что сказать в лог.
        virtual void on_started() {}
        // Зовётся при остановке: поток уже стоит, база ещё открыта.
        virtual void on_stopping() {}

        UConnection& db() { return m_conn; }
        ULogger& logger() { return m_logger; }
        const std::filesystem::path& db_path() const { return m_db_path; }

    private:
        void worker() {
            while (true) {
                std::deque<TEntry> batch;
                {
                    std::unique_lock<std::mutex> lock(m_mutex);
                    m_cv.wait(lock, [this] { return !m_queue.empty() || !m_running.load(); });
                    if (!m_running.load() && m_queue.empty()) break;
                    batch.swap(m_queue);
                }
                for (const auto& entry : batch) {
                    if (!write_one(entry)) {
                        m_logger.warn("write failed, row dropped");
                    }
                }
            }
        }

        std::filesystem::path m_db_path;
        ULogger m_logger;
        UConnection m_conn;

        std::deque<TEntry> m_queue;
        std::mutex m_mutex;
        std::condition_variable m_cv;
        std::thread m_thread;
        std::atomic<bool> m_running{ false };

        static constexpr std::size_t kMaxQueue = 256;
    };

} // namespace db
} // namespace varan
