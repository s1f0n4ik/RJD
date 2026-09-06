#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <string_view>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

#include "console_utility.h"

namespace logger_detail {

    // Ограниченная очередь строк: переполнение считается, а не блокирует
    class UQueue {
    public:
        explicit UQueue(std::size_t capacity) : m_capacity(capacity) {}

        void push(std::string line) {
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                if (m_items.size() >= m_capacity) {
                    ++m_dropped;
                    return;
                }
                m_items.push_back(std::move(line));
            }
            m_cv.notify_one();
        }

        // false — очередь пуста и остановлена
        bool pop(std::string& line, std::size_t& dropped) {
            std::unique_lock<std::mutex> lock(m_mutex);
            m_cv.wait(lock, [this] { return !m_items.empty() || m_stopped; });
            if (m_items.empty()) return false;
            line = std::move(m_items.front());
            m_items.pop_front();
            dropped = m_dropped;
            m_dropped = 0;
            return true;
        }

        void stop() {
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_stopped = true;
            }
            m_cv.notify_all();
        }

    private:
        std::size_t m_capacity;
        std::deque<std::string> m_items;
        std::size_t m_dropped = 0;
        bool m_stopped = false;
        std::mutex m_mutex;
        std::condition_variable m_cv;
    };

    // Писатель в каталог: файл до kFileMaxBytes, каталог до kDirMaxBytes
    class UFileWriter {
    public:
        static constexpr std::uintmax_t kFileMaxBytes = 50ull * 1024 * 1024;
        static constexpr std::uintmax_t kDirMaxBytes = 1024ull * 1024 * 1024;
        static constexpr std::string_view kPrefix = "media-center_";
        static constexpr std::string_view kSuffix = ".log";

        UFileWriter(std::filesystem::path dir, std::string banner)
            : m_dir(std::move(dir))
            , m_banner(std::move(banner))
        {
        }

        void write(const std::string& line) {
            if (!m_stream.is_open() || m_bytes >= kFileMaxBytes) {
                open_next();
                if (!m_stream.is_open()) return;
            }
            m_stream << line << '\n';
            m_stream.flush();
            m_bytes += line.size() + 1;
        }

    private:
        void open_next() {
            if (m_stream.is_open()) m_stream.close();
            m_bytes = 0;

            std::error_code ec;
            std::filesystem::create_directories(m_dir, ec);

            const auto path = unique_path();
            m_stream.open(path, std::ios::out | std::ios::app);
            if (!m_stream.is_open()) {
                std::cerr << "logger: cannot open " << path.string() << std::endl;
                return;
            }

            m_stream << m_banner << '\n';
            m_stream.flush();
            m_bytes += m_banner.size() + 1;

            enforce_dir_limit(path);
        }

        // Два файла в одну секунду получают номерной хвост
        std::filesystem::path unique_path() const {
            using namespace std::chrono;
            const auto itt = system_clock::to_time_t(system_clock::now());
            std::ostringstream stamp;
            stamp << std::put_time(std::localtime(&itt), "%Y-%m-%d_%H-%M-%S");

            std::filesystem::path path = m_dir / (std::string(kPrefix) + stamp.str() + std::string(kSuffix));
            for (int n = 2; std::filesystem::exists(path); ++n) {
                path = m_dir / (std::string(kPrefix) + stamp.str() + "_" + std::to_string(n) + std::string(kSuffix));
            }
            return path;
        }

        // Старые файлы удаляются, пока сумма по каталогу не уложится в предел
        void enforce_dir_limit(const std::filesystem::path& current) const {
            struct FEntry {
                std::filesystem::path path;
                std::uintmax_t size;
            };
            std::vector<FEntry> entries;
            std::uintmax_t total = 0;

            std::error_code ec;
            for (const auto& item : std::filesystem::directory_iterator(m_dir, ec)) {
                if (!item.is_regular_file(ec)) continue;
                const std::string name = item.path().filename().string();
                if (name.rfind(kPrefix, 0) != 0) continue;
                if (name.size() < kSuffix.size() || name.compare(name.size() - kSuffix.size(), kSuffix.size(), kSuffix) != 0) continue;
                if (item.path() == current) continue;
                const auto size = item.file_size(ec);
                if (ec) continue;
                entries.push_back({ item.path(), size });
                total += size;
            }

            // Имя начинается с времени создания, порядок по имени — хронологический
            std::sort(entries.begin(), entries.end(),
                [](const FEntry& a, const FEntry& b) { return a.path.filename() < b.path.filename(); });

            for (const auto& entry : entries) {
                if (total <= kDirMaxBytes) break;
                if (std::filesystem::remove(entry.path, ec)) total -= entry.size;
            }
        }

        std::filesystem::path m_dir;
        std::string m_banner;
        std::ofstream m_stream;
        std::uintmax_t m_bytes = 0;
    };

    // Общий на процесс: консольный писатель и файловый, каждый со своей очередью
    class UHub {
    public:
        static constexpr std::size_t kConsoleQueue = 4096;
        static constexpr std::size_t kFileQueue = 16384;

        static UHub& instance() {
            // Не разрушается: логгеры статиков других единиц живут дольше main
            static UHub* hub = new UHub();
            return *hub;
        }

        void log(const std::string& line, std::string_view color) {
            m_console.push(std::string(color) + line + std::string(color::reset));
            if (m_file_enabled.load(std::memory_order_acquire)) m_file.push(line);
        }

        void enable_file(const std::filesystem::path& dir, const std::string& banner) {
            std::lock_guard<std::mutex> lock(m_file_mutex);
            if (m_file_thread.joinable()) return;
            m_file_thread = std::thread([this, dir, banner] { run_file(dir, banner); });
            m_file_enabled.store(true, std::memory_order_release);
        }

        void shutdown() {
            m_console.stop();
            std::lock_guard<std::mutex> lock(m_file_mutex);
            m_file_enabled.store(false, std::memory_order_release);
            m_file.stop();
            if (m_file_thread.joinable()) m_file_thread.join();
        }

    private:
        UHub()
            : m_console(kConsoleQueue)
            , m_file(kFileQueue)
        {
            // Заблокированный терминал держит этот поток, а не завершение процесса
            std::thread([this] { run_console(); }).detach();
        }

        void run_console() {
            std::string line;
            std::size_t dropped = 0;
            while (m_console.pop(line, dropped)) {
                if (dropped) {
                    std::cout << color::bright_yellow << "console: dropped " << dropped << " lines"
                        << color::reset << std::endl;
                }
                std::cout << line << std::endl;
            }
        }

        void run_file(const std::filesystem::path& dir, const std::string& banner) {
            UFileWriter writer(dir, banner);
            std::string line;
            std::size_t dropped = 0;
            while (m_file.pop(line, dropped)) {
                if (dropped) writer.write("file: dropped " + std::to_string(dropped) + " lines");
                writer.write(line);
            }
        }

        UQueue m_console;
        UQueue m_file;
        std::atomic<bool> m_file_enabled{ false };
        std::mutex m_file_mutex;
        std::thread m_file_thread;
    };

} // namespace logger_detail

class ULogger {
public:
    enum class ELoggerLevel {
        TRACE,
        DEBUG,
        INFO,
        WARNING,
        ERROR,
        SEND,
        RECEIVE
    };

    explicit ULogger(std::string name, ELoggerLevel level = ELoggerLevel::DEBUG)
        : m_object_name(std::move(name))
        , m_level(level)
    {
    }

    ELoggerLevel get_level() {
        return m_level;
    }

    void set_level(ELoggerLevel level) {
        m_level = level;
    }

    // Каталог файлов лога; до вызова строки идут только в консоль
    static void set_log_dir(const std::filesystem::path& dir, const std::string& banner) {
        logger_detail::UHub::instance().enable_file(dir, banner);
    }

    // Дописывает файловую очередь до конца; консольный писатель не ждётся
    static void shutdown() {
        logger_detail::UHub::instance().shutdown();
    }

    void log(ELoggerLevel level, const std::string& message) const {
        if (level < m_level) {
            return;
        }

        std::ostringstream line;
        line << timestamp()
             << " [" << level_to_string(level) << "] "
             << "[" << m_object_name << "] "
             << message;

        logger_detail::UHub::instance().log(line.str(), level_to_color(level));
    }

    // алиасы
    void trace(const std::string& msg) const { log(ELoggerLevel::TRACE, msg); }
    void debug(const std::string& msg) const { log(ELoggerLevel::DEBUG, msg); }
    void info(const std::string& msg) const { log(ELoggerLevel::INFO, msg); }
    void warn(const std::string& msg) const { log(ELoggerLevel::WARNING, msg); }
    void error(const std::string& msg) const { log(ELoggerLevel::ERROR, msg); }
    void send(const std::string& msg) const { log(ELoggerLevel::SEND, msg); }
    void receive(const std::string& msg) const { log(ELoggerLevel::RECEIVE, msg); }

private:
    std::string m_object_name;
    ELoggerLevel m_level = ELoggerLevel::DEBUG;

public:
    static std::string timestamp() {
        using namespace std::chrono;

        auto now = system_clock::now();
        auto itt = system_clock::to_time_t(now);
        auto ms = duration_cast<milliseconds>(now.time_since_epoch()) % 1000;

        std::ostringstream ss;
        ss << std::put_time(std::localtime(&itt), "%Y-%m-%d %H:%M:%S")
           << "." << std::setfill('0') << std::setw(3) << ms.count();

        return ss.str();
    }

    static const char* level_to_string(ELoggerLevel level) {
        switch (level) {
            case ELoggerLevel::TRACE:   return "TRACE";
            case ELoggerLevel::DEBUG:   return "DEBUG";
            case ELoggerLevel::INFO:    return "INFO";
            case ELoggerLevel::WARNING: return "WARN";
            case ELoggerLevel::ERROR:   return "ERROR";
            case ELoggerLevel::SEND:    return "SEND";
            case ELoggerLevel::RECEIVE: return "RECV";
        }
        return "UNK";
    }

    static std::string_view level_to_color(ELoggerLevel level) {
        using namespace color;
        switch (level) {
            case ELoggerLevel::TRACE:   return bright_black;
            case ELoggerLevel::DEBUG:   return bright_black;
            case ELoggerLevel::INFO:    return bright_green;
            case ELoggerLevel::WARNING: return bright_yellow;
            case ELoggerLevel::ERROR:   return bright_red;
            case ELoggerLevel::SEND:    return bright_cyan;
            case ELoggerLevel::RECEIVE: return bright_magenta;
        }
        return reset;
    }
};
