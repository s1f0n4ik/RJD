#include "gateway/core/store.h"
#include "gateway/utility/log.h"

#include <fstream>
#include <sstream>
#include <cstdio>
#include <filesystem>
#include <fcntl.h>
#include <unistd.h>

namespace varan {
    namespace gateway {

        namespace {
            const char* TAG = "store";
        }

        UStore::UStore(std::string path)
            : m_path(std::move(path))
        {}

        boost::json::object UStore::load() const {
            m_read_failed = false;
            if (m_path.empty()) {
                return {};
            }
            std::lock_guard<std::mutex> lock(m_mutex);

            std::ifstream in(m_path, std::ios::binary);
            if (!in) {
                m_read_failed = std::filesystem::exists(m_path);
                return {};  // файла ещё нет — первый запуск
            }
            std::stringstream ss;
            ss << in.rdbuf();
            const std::string text = ss.str();
            if (text.empty()) {
                m_read_failed = true;
                return {};
            }

            boost::system::error_code ec;
            auto parsed = boost::json::parse(text, ec);
            if (ec || !parsed.is_object()) {
                m_read_failed = true;
                ULog::warn(TAG, "settings file is corrupt, ignoring: " + m_path);
                return {};
            }
            return parsed.as_object();
        }

        bool UStore::save(const boost::json::object& root) const {
            if (m_path.empty()) {
                return false;
            }
            std::lock_guard<std::mutex> lock(m_mutex);

            // Пишем во временный файл рядом и переименовываем: rename атомарен, и
            // читатель никогда не увидит полузаписанный JSON.
            const std::string tmp = m_path + ".tmp";
            const auto data = boost::json::serialize(root);
            const int descriptor = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
            if (descriptor < 0) return false;
            std::size_t offset = 0;
            while (offset < data.size()) {
                const auto count = ::write(descriptor, data.data() + offset, data.size() - offset);
                if (count <= 0) { ::close(descriptor); return false; }
                offset += static_cast<std::size_t>(count);
            }
            const bool flushed = ::fsync(descriptor) == 0;
            ::close(descriptor);
            if (!flushed) return false;
            if (std::rename(tmp.c_str(), m_path.c_str()) != 0) {
                ULog::warn(TAG, "cannot replace settings file: " + m_path);
                return false;
            }
            const auto parent = std::filesystem::path(m_path).parent_path();
            const int directory = ::open((parent.empty() ? std::filesystem::path(".") : parent).c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
            if (directory < 0) return false;
            const bool durable = ::fsync(directory) == 0;
            ::close(directory);
            return durable;
        }

    } // namespace gateway
} // namespace varan
