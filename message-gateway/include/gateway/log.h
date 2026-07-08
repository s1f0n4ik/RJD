#pragma once

#include <iostream>
#include <string>
#include <mutex>

namespace varan {
    namespace gateway {

        // Минимальный потокобезопасный логгер, чтобы не тащить в отдельный сервис
        // зависимости ядра. Формат по духу совпадает с media-center: [tag] message.
        class ULog {
        public:
            static void info(const std::string& tag, const std::string& msg) {
                write("INFO ", tag, msg);
            }

            static void warn(const std::string& tag, const std::string& msg) {
                write("WARN ", tag, msg);
            }

            static void error(const std::string& tag, const std::string& msg) {
                write("ERROR", tag, msg);
            }

        private:
            static void write(const char* level, const std::string& tag, const std::string& msg) {
                static std::mutex m;
                std::lock_guard<std::mutex> lock(m);
                std::cout << level << " [" << tag << "] " << msg << std::endl;
            }
        };

    } // namespace gateway
} // namespace varan
