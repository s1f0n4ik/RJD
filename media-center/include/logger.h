#pragma once

#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <mutex>
#include <chrono>
#include <iomanip>

#include "console_utility.h"

class ULogger {
public:
    enum class ELoggerLevel {
        DEBUG,
        INFO,
        WARNING,
        ERROR,
        SEND,
        RECEIVE
    };

    explicit ULogger(std::string name, ELoggerLevel level = ELoggerLevel::DEBUG)
        : m_object_name(name)
        , m_level(level) 
    {
    }

    void set_level(ELoggerLevel level) {
        m_level = level;
    }

    void enable_file(const std::string& path) {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_file.open(path, std::ios::out | std::ios::app);
        m_file_enabled = m_file.is_open();
    }

    void disable_file() {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (m_file.is_open())
            m_file.close();
        m_file_enabled = false;
    }

    void log(ELoggerLevel level, const std::string& message) {
        if (level < m_level)
            return;

        const std::string time = timestamp();
        const auto& level_name = level_to_string(level);
        const auto& level_color = level_to_color(level);

        std::ostringstream line;
        line << time
             << " [" << level_name << "] "
             << "[" << m_object_name << "] "
             << message;

        {
            std::lock_guard<std::mutex> lock(m_mutex);

            std::cout << level_color
                << line.str()
                << color::reset
                << std::endl;

            if (m_file_enabled) {
                m_file << time
                    << " [" << level_name << "] "
                    << "[" << m_object_name << "] "
                    << message
                    << std::endl;
            }
        }
    }

    // алиасы
    void debug(const std::string& msg) { log(ELoggerLevel::DEBUG, msg); }
    void info(const std::string& msg) { log(ELoggerLevel::INFO, msg); }
    void warn(const std::string& msg) { log(ELoggerLevel::WARNING, msg); }
    void error(const std::string& msg) { log(ELoggerLevel::ERROR, msg); }
    void send(const std::string& msg) { log(ELoggerLevel::SEND, msg); }
    void receive(const std::string& msg) { log(ELoggerLevel::RECEIVE, msg); }

private:
    std::string m_object_name;
    ELoggerLevel m_level = ELoggerLevel::DEBUG;

    std::ofstream m_file;
    bool m_file_enabled = false;

    std::mutex m_mutex;

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
