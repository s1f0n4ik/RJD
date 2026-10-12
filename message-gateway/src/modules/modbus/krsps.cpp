#include "gateway/modules/modbus/krsps.h"
#include "gateway/utility/clock.h"
#include "gateway/utility/log.h"

#include <algorithm>

namespace varan {
namespace gateway {

    namespace json = boost::json;
    using namespace modbus;
    using namespace krsps;

    namespace {

        const char* TAG = "modbus:krsps";

        // 2025-01-01 и 2051-01-01 UTC
        constexpr std::int64_t TIME_MIN_S = 1735689600;
        constexpr std::int64_t TIME_MAX_S = 2556144000;

        bool join_angle(const std::uint16_t* r, int max_deg, double& out) {
            if (r[0] > max_deg || r[1] >= 60 || r[2] >= 10000) {
                return false;
            }
            out = r[0] + r[1] / 60.0 + r[2] / 600000.0;
            return out <= max_deg;
        }

        // Диапазон регистров [start, start + count) задевает [from, to)
        bool overlaps(int start, int count, int from, int to) {
            return start < to && from < start + count;
        }

    } // namespace

    bool decode_master_gps(const std::uint16_t* regs, double& lat, double& lon) {
        int lat_sign = 0;
        int lon_sign = 0;
        for (int i = 6; i < 8; ++i) {
            switch (regs[i]) {
            case 'N': lat_sign = 1; break;
            case 'S': lat_sign = -1; break;
            case 'E': lon_sign = 1; break;
            case 'W': lon_sign = -1; break;
            default: break;
            }
        }
        double la = 0.0;
        double lo = 0.0;
        if (!lat_sign || !lon_sign || !join_angle(regs, 90, la) || !join_angle(regs + 3, 180, lo)) {
            return false;
        }
        lat = lat_sign * la;
        lon = lon_sign * lo;
        return true;
    }

    bool decode_master_time(const std::uint16_t* regs, std::int64_t& unix_s) {
        std::uint64_t v = 0;
        for (int i = 0; i < 4; ++i) {
            v |= static_cast<std::uint64_t>(regs[i]) << (16 * i);
        }
        const auto s = static_cast<std::int64_t>(v);
        if (s < TIME_MIN_S || s >= TIME_MAX_S) {
            return false;
        }
        unix_s = s;
        return true;
    }

    AKrspsModule::AKrspsModule(boost::asio::io_context& ioc, FModbusConfig config, std::string queue_file)
        : AModbusModule(ioc, std::move(config))
        , m_queue(std::move(queue_file))
    {}

    std::uint8_t AKrspsModule::on_command(std::uint16_t, FExchange&) {
        return EX_ILLEGAL_VALUE;
    }

    std::uint8_t AKrspsModule::on_settings(std::uint16_t, const std::uint16_t*, std::uint16_t, FExchange&) {
        return EX_ILLEGAL_ADDRESS;
    }

    std::uint16_t AKrspsModule::holding(std::uint16_t reg) const {
        return reg >= SPACE_BEGIN && reg < SPACE_END ? m_holding[reg - SPACE_BEGIN] : 0;
    }

    std::uint16_t AKrspsModule::record_length() const {
        const auto list = packets();
        if (list.empty()) {
            return 0;
        }
        const std::uint16_t length = list.front()->length();
        for (const auto* p : list) {
            if (p->length() != length) {
                return 0;
            }
        }
        // Запись другой длины в очереди — 0
        return m_queue.uniform(length) ? length : 0;
    }

    const AModbusPacket* AKrspsModule::find_packet(std::uint16_t kind) const {
        for (const auto* p : packets()) {
            if (p->kind() == kind) {
                return p;
            }
        }
        return nullptr;
    }

    FModbusRecord AKrspsModule::enqueue(const AModbusPacket& packet, std::vector<std::uint16_t> regs,
        std::int64_t utc_ms) {
        FModbusRecord r;
        r.packet = packet.kind();
        std::lock_guard<std::mutex> lock(m_sync_mutex);
        r.hidden = !m_synced.load();
        if (!utc_ms) {
            std::lock_guard<std::mutex> info(m_info_mutex);
            utc_ms = r.hidden ? now_ms() : m_time_s * 1000 + (mono_ms() - m_time_mono);
        }
        r.utc_ms = utc_ms;
        packet.stamp(regs, utc_ms);
        r.regs = std::move(regs);
        r.number = m_queue.push(r);
        r.regs[1] = r.number;
        return r;
    }

    std::uint8_t AKrspsModule::read_input(std::uint16_t start, std::uint16_t count, std::uint16_t* values,
        FExchange& ex) {
        ex.kind = "info";
        if (start < SPACE_BEGIN || start + count > SPACE_END) {
            return EX_ILLEGAL_ADDRESS;
        }

        const FModbusConfig cfg = config();
        const auto states = state_registers();
        const std::uint16_t visible = m_queue.visible();
        // Идентификатор, версия, длина записи, регистров окна, регистров команд, регистров состояния, записей, состояние
        std::vector<std::uint16_t> block{
            static_cast<std::uint16_t>(cfg.device_id), static_cast<std::uint16_t>(cfg.version), record_length(),
            static_cast<std::uint16_t>(UModbusQueue::WINDOW), COMMAND_REGS,
            static_cast<std::uint16_t>(std::max<std::size_t>(states.size(), 1)), visible };
        for (const auto& s : states) {
            block.push_back(s.value);
        }
        if (states.empty()) {
            block.push_back(0);
        }

        for (std::uint16_t i = 0; i < count; ++i) {
            const std::size_t reg = static_cast<std::size_t>(start + i - STATE_BLOCK);
            if (reg < block.size()) {
                values[i] = block[reg];
            }
        }
        if (overlaps(start, count, STATE_BLOCK + STATE_FIXED - 1, STATE_BLOCK + static_cast<int>(block.size()))) {
            ex.kind = "state";
            ex.detail["count"] = visible;
            ex.detail["state"] = block[STATE_FIXED];
        }
        if (start + count > RECORDS) {
            const int from = std::max<int>(start, RECORDS);
            const auto numbers = m_queue.window(static_cast<std::size_t>(from - RECORDS),
                static_cast<std::size_t>(start + count - from), values + (from - start));
            json::array list;
            for (auto num : numbers) {
                list.push_back(num);
            }
            ex.kind = "records";
            ex.detail["records"] = std::move(list);
        }
        return 0;
    }

    std::uint8_t AKrspsModule::write_holding(std::uint16_t start, const std::uint16_t* values, std::uint16_t count,
        FExchange& ex) {
        ex.kind = "write";
        if (start >= SETTINGS && start + count <= SETTINGS + SETTINGS_COUNT) {
            return on_settings(start, values, count, ex);
        }
        if (start < SPACE_BEGIN || start + count > SPACE_END) {
            return EX_ILLEGAL_ADDRESS;
        }
        std::copy(values, values + count, m_holding.begin() + (start - SPACE_BEGIN));

        if (start <= COMMAND && COMMAND < start + count) {
            const std::uint16_t cmd = m_holding[COMMAND - SPACE_BEGIN];
            if (cmd == CMD_MARK) {
                mark(ex);
            }
            else if (cmd != CMD_NONE) {
                ex.detail["command"] = cmd;
                if (const std::uint8_t exc = on_command(cmd, ex)) {
                    return exc;
                }
            }
        }
        // Блок координат и блок времени дописан до последнего регистра
        if (start <= MASTER_GPS + 7 && MASTER_GPS + 7 < start + count) {
            master_gps(ex);
        }
        if (start <= MASTER_TIME + 3 && MASTER_TIME + 3 < start + count) {
            master_time(ex);
        }
        return 0;
    }

    void AKrspsModule::mark(FExchange& ex) {
        const std::uint16_t first = m_holding[COMMAND + 1 - SPACE_BEGIN];
        const std::uint16_t last = m_holding[COMMAND + 2 - SPACE_BEGIN];
        const auto r = m_queue.mark(first, last);

        json::object detail{ {"first", first}, {"last", last}, {"ok", r.ok}, {"removed", r.removed}, {"head", r.head} };
        ex.kind = "mark";
        ex.detail = detail;
        {
            std::lock_guard<std::mutex> lock(m_info_mutex);
            detail["mono"] = mono_ms();
            m_last_mark = std::move(detail);
        }
        const std::string range = "#" + std::to_string(first) + "..#" + std::to_string(last);
        if (r.ok) {
            ++m_marks_ok;
            ULog::info(TAG, "Records " + range + " marked as read");
        }
        else {
            ++m_marks_rejected;
            ULog::warn(TAG, "Mark " + range + " rejected, first visible #" + std::to_string(r.head));
        }
    }

    void AKrspsModule::master_gps(FExchange& ex) {
        double lat = 0.0;
        double lon = 0.0;
        const bool ok = decode_master_gps(&m_holding[MASTER_GPS - SPACE_BEGIN], lat, lon);
        ex.kind = "time";
        ex.detail["gps_ok"] = ok;
        if (!ok) {
            ++m_gps_invalid;
            return;
        }
        ex.detail["lat"] = lat;
        ex.detail["lon"] = lon;
        on_master_gps(lat, lon);
        std::lock_guard<std::mutex> lock(m_info_mutex);
        m_lat = lat;
        m_lon = lon;
        m_gps_mono = mono_ms();
    }

    void AKrspsModule::master_time(FExchange& ex) {
        std::int64_t unix_s = 0;
        const bool ok = decode_master_time(&m_holding[MASTER_TIME - SPACE_BEGIN], unix_s);
        ex.kind = "time";
        ex.detail["time_ok"] = ok;
        if (!ok) {
            ++m_time_invalid;
            return;
        }
        ex.detail["unix_s"] = unix_s;
        on_master_time(unix_s);
        ++m_time_updates;
        {
            std::lock_guard<std::mutex> lock(m_info_mutex);
            m_time_s = unix_s;
            m_time_mono = mono_ms();
        }

        std::lock_guard<std::mutex> lock(m_sync_mutex);
        if (m_synced.load()) {
            return;
        }
        const std::int64_t offset = unix_s * 1000 - now_ms();
        m_sync_offset_ms = offset;
        m_synced = true;
        const int revealed = m_queue.reveal(offset, [this](FModbusRecord& r) {
            if (const auto* p = find_packet(r.packet)) {
                p->stamp(r.regs, r.utc_ms);
            }
        });
        ULog::info(TAG, "First time from master, board clock offset " + std::to_string(offset) + " ms, " +
            std::to_string(revealed) + " hidden record(s) revealed");
    }

    boost::json::object AKrspsModule::record_json(const FModbusRecord& r) const {
        json::array regs;
        for (auto v : r.regs) {
            regs.push_back(v);
        }
        json::array fields;
        if (const auto* p = find_packet(r.packet)) {
            for (const auto& f : p->describe(r.regs)) {
                json::object o{ {"label", f.label}, {"reg", f.reg}, {"count", f.count}, {"kind", f.kind}, {"value", f.value} };
                if (!f.note.empty()) {
                    o["note"] = f.note;
                }
                if (!f.text.empty()) {
                    o["text"] = f.text;
                }
                if (f.brief) {
                    o["brief"] = true;
                }
                fields.push_back(std::move(o));
            }
        }
        json::object o;
        o["number"] = r.number;
        o["packet"] = r.packet;
        o["ts"] = r.utc_ms;
        o["regs"] = std::move(regs);
        o["fields"] = std::move(fields);
        return o;
    }

    void AKrspsModule::status(json::object& m) const {
        const FModbusConfig cfg = config();
        const std::int64_t now = mono_ms();
        const auto states = state_registers();
        const auto snap = m_queue.snapshot();

        auto& slave = m["slave"].as_object();
        slave["device_id"] = cfg.device_id;
        slave["version"] = cfg.version;

        m["block"] = json::array{ cfg.device_id, cfg.version, record_length(), UModbusQueue::WINDOW, COMMAND_REGS,
            std::max<std::size_t>(states.size(), 1), std::min<std::size_t>(snap.visible, 65535) };

        json::array registers;
        for (std::size_t i = 0; i < states.size(); ++i) {
            const auto& s = states[i];
            json::array reason;
            for (const auto& part : s.reason) {
                reason.push_back(json::value(part));
            }
            json::object o;
            o["addr"] = STATE_BLOCK + STATE_FIXED + i;
            o["value"] = s.value;
            o["label"] = s.label;
            o["ok"] = s.ok;
            o["code"] = s.code;
            o["reason"] = std::move(reason);
            o["error"] = s.error;
            registers.push_back(std::move(o));
        }
        json::object state;
        state["registers"] = std::move(registers);
        m["state"] = std::move(state);

        json::object time;
        json::object gps;
        json::object last_mark;
        {
            std::lock_guard<std::mutex> lock(m_info_mutex);
            time["synced"] = m_synced.load();
            time["offset_ms"] = m_sync_offset_ms.load();
            time["unix_s"] = m_time_s;
            time["age_ms"] = m_time_mono ? now - m_time_mono : -1;
            time["updates"] = m_time_updates.load();
            time["invalid"] = m_time_invalid.load();

            gps["valid"] = m_gps_mono != 0 && now - m_gps_mono <= MASTER_SILENCE_MS;
            gps["lat"] = m_lat;
            gps["lon"] = m_lon;
            gps["age_ms"] = m_gps_mono ? now - m_gps_mono : -1;
            gps["invalid"] = m_gps_invalid.load();

            last_mark = m_last_mark;
        }
        if (auto* mono = last_mark.if_contains("mono"); mono && mono->is_int64()) {
            last_mark["age_ms"] = now - mono->as_int64();
            last_mark.erase("mono");
        }
        m["time"] = std::move(time);
        m["gps"] = std::move(gps);

        json::array recent;
        for (const auto& e : snap.recent) {
            json::object o = record_json(e.r);
            o["status"] = e.status;
            recent.push_back(std::move(o));
        }
        json::object queue;
        queue["total"] = snap.total;
        queue["visible"] = snap.visible;
        queue["hidden"] = snap.hidden;
        queue["window"] = snap.window;
        queue["dropped"] = snap.dropped;
        queue["next_number"] = snap.next;
        queue["capacity"] = UModbusQueue::CAPACITY;
        queue["recent"] = std::move(recent);
        queue["head"] = snap.head ? json::value(record_json(*snap.head)) : json::value(nullptr);
        queue["last_mark"] = last_mark.empty() ? json::value(nullptr) : json::value(std::move(last_mark));
        m["queue"] = std::move(queue);

        auto& counters = m["counters"].as_object();
        counters["marks_ok"] = m_marks_ok.load();
        counters["marks_rejected"] = m_marks_rejected.load();
    }

} // namespace gateway
} // namespace varan
