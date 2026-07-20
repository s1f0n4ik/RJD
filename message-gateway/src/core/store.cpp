#include "gateway/core/store.h"
#include "gateway/utility/log.h"

#include <fstream>
#include <sstream>
#include <cstdio>

namespace varan {
    namespace gateway {

        namespace {
            const char* TAG = "store";
        }

        UStore::UStore(std::string path)
            : m_path(std::move(path))
        {}

        boost::json::object UStore::load() const {
            if (m_path.empty()) {
                return {};
            }
            std::lock_guard<std::mutex> lock(m_mutex);

            std::ifstream in(m_path, std::ios::binary);
            if (!in) {
                return {};  // файла ещё нет — первый запуск
            }
            std::stringstream ss;
            ss << in.rdbuf();
            const std::string text = ss.str();
            if (text.empty()) {
                return {};
            }

            boost::system::error_code ec;
            auto parsed = boost::json::parse(text, ec);
            if (ec || !parsed.is_object()) {
                ULog::warn(TAG, "settings file is corrupt, ignoring: " + m_path);
                return {};
            }
            return parsed.as_object();
        }

        void UStore::save(const boost::json::object& root) const {
            if (m_path.empty()) {
                return;
            }
            std::lock_guard<std::mutex> lock(m_mutex);

            // Пишем во временный файл рядом и переименовываем: rename атомарен, и
            // читатель никогда не увидит полузаписанный JSON.
            const std::string tmp = m_path + ".tmp";
            {
                std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
                if (!out) {
                    ULog::warn(TAG, "cannot write settings file: " + tmp);
                    return;
                }
                out << boost::json::serialize(root);
                out.flush();
                if (!out) {
                    ULog::warn(TAG, "failed to flush settings file: " + tmp);
                    return;
                }
            }
            std::remove(m_path.c_str());
            if (std::rename(tmp.c_str(), m_path.c_str()) != 0) {
                ULog::warn(TAG, "cannot replace settings file: " + m_path);
            }
        }

    } // namespace gateway
} // namespace varan
