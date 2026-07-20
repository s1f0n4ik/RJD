#include "gateway/modules/can/traffic-log.h"
#include "gateway/utility/clock.h"

#include <cstdio>

namespace varan {
    namespace gateway {

        namespace json = boost::json;

        std::string UCanLog::hex_id(std::uint32_t id) {
            char buf[16];
            std::snprintf(buf, sizeof(buf), "0x%08X", id);
            return buf;
        }

        std::string UCanLog::hex_data(const std::array<std::uint8_t, 8>& data, std::uint8_t dlc) {
            std::string out;
            char buf[4];
            for (std::uint8_t i = 0; i < dlc && i < 8; ++i) {
                if (i) out += ' ';
                std::snprintf(buf, sizeof(buf), "%02X", data[i]);
                out += buf;
            }
            return out;
        }

        void UCanLog::push(const FCanFrame& f, bool tx, std::int64_t ts_ms,
            std::string note, std::string error) {
            FRecord r;
            r.seq = m_seq.fetch_add(1) + 1;
            r.ts_ms = ts_ms;
            r.tx = tx;
            r.id = f.id;
            r.dlc = f.dlc;
            r.data = f.data;
            r.note = std::move(note);
            r.error = std::move(error);

            std::lock_guard<std::mutex> lock(m_mutex);
            m_ring.push_back(std::move(r));
            if (m_ring.size() > m_capacity) {
                m_ring.pop_front();
            }
        }

        boost::json::array UCanLog::to_json() const {
            json::array out;
            std::lock_guard<std::mutex> lock(m_mutex);
            out.reserve(m_ring.size());
            // Новые сверху — лента читается с последнего события.
            for (auto it = m_ring.rbegin(); it != m_ring.rend(); ++it) {
                json::object o;
                o["seq"] = it->seq;
                o["ts"] = it->ts_ms;
                o["dir"] = it->tx ? "tx" : "rx";
                o["id"] = hex_id(it->id);
                o["data"] = hex_data(it->data, it->dlc);
                o["note"] = it->note;
                if (!it->error.empty()) {
                    o["error"] = it->error;
                }
                out.push_back(std::move(o));
            }
            return out;
        }

        boost::json::object UCanLog::summary_json(const FSummary& s) {
            json::object o;
            o["key"] = s.key;
            o["title"] = s.title;
            o["dir"] = s.tx ? "tx" : "rx";
            o["enabled"] = s.enabled;
            o["id"] = hex_id(s.id);
            o["count"] = s.count;
            o["errors"] = s.errors;
            o["data"] = hex_data(s.data, s.dlc);
            o["note"] = s.note;
            // -1 — кадров этого типа ещё не было; страница покажет прочерк, а не
            // возраст «с начала эпохи».
            o["age_ms"] = s.last_mono ? (mono_ms() - s.last_mono) : -1;
            return o;
        }

    } // namespace gateway
} // namespace varan
