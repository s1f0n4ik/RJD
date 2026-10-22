#include "gateway/modules/modbus/module.h"
#include "gateway/utility/clock.h"
#include "gateway/utility/log.h"

#include <algorithm>
#include <cstdio>

namespace varan {
namespace gateway {

    namespace json = boost::json;
    using namespace modbus;

    namespace {

        const char* TAG = "module:modbus";
        constexpr int RETRY_SEC = 5;
        constexpr int GAP_MS = 50;
        constexpr int HOUSEKEEPING_SEC = 5;
        constexpr std::size_t LOG_CAPACITY = 100;
        constexpr std::size_t HEX_BYTES = 24;

        std::uint16_t be16(const std::uint8_t* p) {
            return static_cast<std::uint16_t>((p[0] << 8) | p[1]);
        }

        void put_be16(std::vector<std::uint8_t>& out, std::uint16_t v) {
            out.push_back(static_cast<std::uint8_t>(v >> 8));
            out.push_back(static_cast<std::uint8_t>(v & 0xFF));
        }

        bool crc_ok(const std::uint8_t* d, std::size_t n) {
            const std::uint16_t crc = modbus_crc(d, n - 2);
            return d[n - 2] == (crc & 0xFF) && d[n - 1] == (crc >> 8);
        }

        std::string hex(const std::uint8_t* d, std::size_t n, std::size_t limit = HEX_BYTES) {
            std::string out;
            char buf[4];
            for (std::size_t i = 0; i < n && i < limit; ++i) {
                std::snprintf(buf, sizeof(buf), i ? " %02X" : "%02X", d[i]);
                out += buf;
            }
            if (n > limit) {
                out += " …";
            }
            return out;
        }

        const char* FRAME_TAG = "modbus:frame";

        const char* exception_name(std::uint8_t code) {
            switch (code) {
            case EX_ILLEGAL_FUNCTION: return "illegal function";
            case EX_ILLEGAL_ADDRESS: return "illegal address";
            case EX_ILLEGAL_VALUE: return "illegal value";
            default: return "unknown";
            }
        }

        // Запрос ведущего словами: функция, регистры
        std::string request_text(const std::uint8_t* f, std::size_t n) {
            char buf[48];
            const unsigned reg = n >= 4 ? be16(f + 2) : 0u;
            const unsigned val = n >= 6 ? be16(f + 4) : 0u;
            switch (f[1]) {
            case 0x03: std::snprintf(buf, sizeof(buf), "read holding 0x%04Xx%u", reg, val); break;
            case FC_READ_INPUT: std::snprintf(buf, sizeof(buf), "read 0x%04Xx%u", reg, val); break;
            case FC_WRITE_SINGLE: std::snprintf(buf, sizeof(buf), "write 0x%04X = %u", reg, val); break;
            case FC_WRITE_MULTIPLE: std::snprintf(buf, sizeof(buf), "write 0x%04Xx%u", reg, val); break;
            case 0x11: return "report slave id";
            default: std::snprintf(buf, sizeof(buf), "function 0x%02X", f[1]); break;
            }
            return buf;
        }

        // Ответ ведомого словами; значения — только до 8 регистров
        std::string response_text(const std::uint8_t* f, std::size_t n) {
            char buf[48];
            if (f[1] & 0x80) {
                std::snprintf(buf, sizeof(buf), "exception %02X (%s)", f[2], exception_name(f[2]));
                return buf;
            }
            switch (f[1]) {
            case 0x03:
            case FC_READ_INPUT: {
                const std::size_t bytes = f[2];
                std::string s = "response " + std::to_string(bytes) + " bytes";
                if (bytes / 2 <= 8 && 3 + bytes <= n) {
                    s += ":";
                    for (std::size_t i = 0; i < bytes / 2; ++i) {
                        s += " " + std::to_string(be16(f + 3 + 2 * i));
                    }
                }
                return s;
            }
            case FC_WRITE_SINGLE:
                std::snprintf(buf, sizeof(buf), "ack 0x%04X = %u", unsigned{ be16(f + 2) }, unsigned{ be16(f + 4) });
                return buf;
            case FC_WRITE_MULTIPLE:
                std::snprintf(buf, sizeof(buf), "ack 0x%04Xx%u", unsigned{ be16(f + 2) }, unsigned{ be16(f + 4) });
                return buf;
            default:
                std::snprintf(buf, sizeof(buf), "function 0x%02X", f[1]);
                return buf;
            }
        }

        // Строка кадра: направление, адрес, функция, разбор, все байты
        void log_frame(const char* dir, const std::uint8_t* f, std::size_t n, const std::string& text, bool warn = false) {
            char head[16];
            std::snprintf(head, sizeof(head), "%s %u %02X ", dir, unsigned{ f[0] }, f[1]);
            const std::string line = head + text + " | " + hex(f, n, n);
            if (warn) {
                ULog::warn(FRAME_TAG, line);
            }
            else {
                ULog::info(FRAME_TAG, line);
            }
        }

        // Запрос с неверным CRC: принятые и посчитанные байты CRC в порядке линии
        void log_bad_crc(const std::uint8_t* f, std::size_t n) {
            const std::uint16_t crc = modbus_crc(f, n - 2);
            char head[24];
            std::snprintf(head, sizeof(head), "RX bad CRC: %u %02X ", unsigned{ f[0] }, f[1]);
            char tail[48];
            std::snprintf(tail, sizeof(tail), ", CRC %02X %02X instead of %02X %02X", f[n - 2], f[n - 1], crc & 0xFF, crc >> 8);
            ULog::warn(FRAME_TAG, head + request_text(f, n) + tail + " | " + hex(f, n, n));
        }

        std::string describe(const FModbusConfig& c) {
            const char* parity = c.parity == "even" ? "E" : (c.parity == "odd" ? "O" : "N");
            return c.device + " @ " + std::to_string(c.baud) + " " + std::to_string(c.data_bits) + parity +
                std::to_string(c.stop_bits);
        }

    } // namespace

    AModbusModule::AModbusModule(boost::asio::io_context& ioc, FModbusConfig config)
        : m_ioc(ioc)
        , m_config(std::move(config))
        , m_retry_timer(ioc)
        , m_gap_timer(ioc)
        , m_housekeeping_timer(ioc)
    {}

    FModbusConfig AModbusModule::config() const {
        std::lock_guard<std::mutex> lock(m_mutex);
        return m_config;
    }

    void AModbusModule::set_error(const std::string& err) {
        std::lock_guard<std::mutex> lock(m_err_mutex);
        m_error = err;
    }

    std::string AModbusModule::error() const {
        std::lock_guard<std::mutex> lock(m_err_mutex);
        return m_error;
    }

    void AModbusModule::start() {
        if (m_active.exchange(true)) {
            return;
        }
        boost::asio::post(m_ioc, [this] {
            try_open();
            housekeeping();
        });
        ULog::info(TAG, "Started");
    }

    void AModbusModule::stop() {
        if (!m_active.exchange(false)) {
            return;
        }
        boost::asio::post(m_ioc, [this] {
            m_retry_timer.cancel();
            m_housekeeping_timer.cancel();
            close_port();
            m_attempt = 0;
        });
        ULog::info(TAG, "Stopped");
    }

    bool AModbusModule::connected() const {
        return m_connected.load();
    }

    void AModbusModule::try_open() {
        if (!m_active.load() || m_port) {
            return;
        }
        const FModbusConfig cfg = config();
        if (!cfg.enabled) {
            return;
        }
        ++m_attempt;

        using base = boost::asio::serial_port_base;
        auto port = std::make_unique<boost::asio::serial_port>(m_ioc);
        boost::system::error_code ec;
        port->open(cfg.device, ec);
        if (ec) {
            set_error("open " + cfg.device + ": " + ec.message());
            schedule_retry();
            return;
        }
        port->set_option(base::baud_rate(static_cast<unsigned>(cfg.baud)), ec);
        if (!ec) port->set_option(base::character_size(static_cast<unsigned>(cfg.data_bits)), ec);
        if (!ec) port->set_option(base::parity(cfg.parity == "even" ? base::parity::even
            : (cfg.parity == "odd" ? base::parity::odd : base::parity::none)), ec);
        if (!ec) port->set_option(base::stop_bits(cfg.stop_bits == 2 ? base::stop_bits::two : base::stop_bits::one), ec);
        if (!ec) port->set_option(base::flow_control(base::flow_control::none), ec);
        if (ec) {
            set_error("configure " + cfg.device + ": " + ec.message());
            boost::system::error_code ignore;
            port->close(ignore);
            schedule_retry();
            return;
        }

        m_port = std::move(port);
        m_buf.clear();
        m_aligned = true;
        m_expect = -1;
        m_connected = true;
        m_attempt = 0;
        set_error("");
        ULog::info(TAG, "Opened " + describe(cfg) + ", slave " + std::to_string(cfg.slave));
        start_read(++m_gen);
    }

    void AModbusModule::close_port() {
        ++m_gen;
        m_gap_timer.cancel();
        if (m_port) {
            boost::system::error_code ec;
            m_port->close(ec);
            m_port.reset();
        }
        m_connected = false;
        m_buf.clear();
        m_junk.clear();
    }

    void AModbusModule::schedule_retry() {
        if (!m_active.load()) {
            return;
        }
        m_waiting = true;
        m_next_retry_mono = mono_ms() + RETRY_SEC * 1000;
        m_retry_timer.expires_after(std::chrono::seconds(RETRY_SEC));
        m_retry_timer.async_wait([this](const boost::system::error_code& ec) {
            m_waiting = false;
            m_next_retry_mono = 0;
            if (!ec) {
                try_open();
            }
        });
    }

    void AModbusModule::on_failure(const std::string& err) {
        ULog::warn(TAG, err);
        set_error(err);
        close_port();
        schedule_retry();
    }

    void AModbusModule::start_read(unsigned gen) {
        m_port->async_read_some(boost::asio::buffer(m_chunk),
            [this, gen](const boost::system::error_code& ec, std::size_t n) {
                if (gen != m_gen) {
                    return;
                }
                if (ec) {
                    on_failure("read: " + ec.message());
                    return;
                }
                m_buf.insert(m_buf.end(), m_chunk.begin(), m_chunk.begin() + static_cast<std::ptrdiff_t>(n));
                parse();
                if (gen != m_gen) {
                    return;
                }
                arm_gap();
                start_read(gen);
            });
    }

    // Тишина после последнего байта: хвост буфера — мусор, следующий байт начинает кадр
    void AModbusModule::arm_gap() {
        m_gap_timer.expires_after(std::chrono::milliseconds(GAP_MS));
        m_gap_timer.async_wait([this, gen = m_gen](const boost::system::error_code& ec) {
            if (ec || gen != m_gen) {
                return;
            }
            flush_garbage();
        });
    }

    void AModbusModule::drop(std::size_t n) {
        m_junk.insert(m_junk.end(), m_buf.begin(), m_buf.begin() + static_cast<std::ptrdiff_t>(n));
        m_buf.erase(m_buf.begin(), m_buf.begin() + static_cast<std::ptrdiff_t>(n));
        m_garbage += static_cast<std::int64_t>(n);
        m_aligned = false;
        // Шум без пауз — строкой на каждые MAX_ADU байт
        if (m_junk.size() >= MAX_ADU) {
            log_junk();
        }
    }

    void AModbusModule::log_junk() {
        if (m_junk.empty()) {
            return;
        }
        ULog::warn(FRAME_TAG, "RX garbage " + std::to_string(m_junk.size()) + " bytes | " +
            hex(m_junk.data(), m_junk.size(), m_junk.size()));
        m_junk.clear();
    }

    void AModbusModule::flush_garbage() {
        while (!m_buf.empty()) {
            drop(1);
            parse();
            if (!m_port) {
                return;
            }
        }
        log_junk();
        m_aligned = true;
    }

    // Кадр по коду функции; не сошёлся CRC — сдвиг на байт
    void AModbusModule::parse() {
        while (m_buf.size() >= 4) {
            if (m_expect >= 0 && m_buf[0] == m_expect) {
                const std::size_t len = response_length(m_buf.data(), m_buf.size());
                if (len == NEED_MORE) {
                    return;
                }
                if (len != UNKNOWN && len <= MAX_ADU) {
                    if (m_buf.size() < len) {
                        return;
                    }
                    if (crc_ok(m_buf.data(), len)) {
                        log_junk();
                        log_frame("RX", m_buf.data(), len, "foreign " + response_text(m_buf.data(), len));
                        m_buf.erase(m_buf.begin(), m_buf.begin() + static_cast<std::ptrdiff_t>(len));
                        m_expect = -1;
                        m_aligned = true;
                        continue;
                    }
                }
            }

            const std::size_t len = m_buf[0] > 247 ? UNKNOWN : request_length(m_buf.data(), m_buf.size());
            if (len == NEED_MORE) {
                return;
            }
            if (len == UNKNOWN || len > MAX_ADU) {
                drop(1);
                continue;
            }
            if (m_buf.size() < len) {
                return;
            }
            if (!crc_ok(m_buf.data(), len)) {
                if (m_aligned) {
                    ++m_crc_errors;
                    log_bad_crc(m_buf.data(), len);
                }
                drop(1);
                continue;
            }
            const std::vector<std::uint8_t> frame(m_buf.begin(), m_buf.begin() + static_cast<std::ptrdiff_t>(len));
            m_buf.erase(m_buf.begin(), m_buf.begin() + static_cast<std::ptrdiff_t>(len));
            m_aligned = true;
            m_expect = -1;
            log_junk();
            on_request(frame.data(), frame.size());
            if (!m_port) {
                return;
            }
        }
    }

    void AModbusModule::on_request(const std::uint8_t* f, std::size_t n) {
        const FModbusConfig cfg = config();
        const std::uint8_t addr = f[0];
        const std::uint8_t fc = f[1];
        if (addr != 0 && addr != cfg.slave) {
            log_frame("RX", f, n, "foreign " + request_text(f, n));
            ++m_foreign;
            m_foreign_last = addr;
            m_expect = addr;
            return;
        }

        const bool broadcast = addr == 0;
        log_frame("RX", f, n, (broadcast ? "broadcast " : "") + request_text(f, n));
        m_last_master_mono = mono_ms();
        if (!m_master_online) {
            m_master_online = true;
            ULog::info(TAG, "Master is online");
        }
        if (broadcast) {
            ++m_broadcasts;
        }
        else {
            ++m_requests;
        }

        FExchange ex;
        ex.address = addr;
        ex.function = fc;
        ex.rx = hex(f, n);
        std::vector<std::uint8_t> rsp{ addr, fc };
        std::uint8_t exc = 0;

        switch (fc) {
        case FC_READ_INPUT: {
            // Широковещательное чтение не исполняется
            if (broadcast) {
                return;
            }
            const std::uint16_t start = be16(f + 2);
            const std::uint16_t count = be16(f + 4);
            ex.reg = start;
            ex.count = count;
            if (count < 1 || count > 125) {
                exc = EX_ILLEGAL_VALUE;
                break;
            }
            std::vector<std::uint16_t> values(count, 0);
            exc = read_input(start, count, values.data(), ex);
            if (!exc) {
                rsp.push_back(static_cast<std::uint8_t>(count * 2));
                for (auto v : values) {
                    put_be16(rsp, v);
                }
            }
            break;
        }
        case FC_WRITE_SINGLE: {
            const std::uint16_t value = be16(f + 4);
            ex.reg = be16(f + 2);
            ex.count = 1;
            exc = write_holding(be16(f + 2), &value, 1, ex);
            if (!exc) {
                rsp.insert(rsp.end(), f + 2, f + 6);
            }
            break;
        }
        case FC_WRITE_MULTIPLE: {
            const std::uint16_t count = be16(f + 4);
            ex.reg = be16(f + 2);
            ex.count = count;
            if (count < 1 || count > 123 || f[6] != count * 2) {
                exc = EX_ILLEGAL_VALUE;
                break;
            }
            std::vector<std::uint16_t> values(count);
            for (std::uint16_t i = 0; i < count; ++i) {
                values[i] = be16(f + 7 + 2 * i);
            }
            exc = write_holding(be16(f + 2), values.data(), count, ex);
            if (!exc) {
                rsp.insert(rsp.end(), f + 2, f + 6);
            }
            break;
        }
        default:
            ex.kind = "unsupported";
            exc = EX_ILLEGAL_FUNCTION;
            break;
        }

        if (exc) {
            rsp = { addr, static_cast<std::uint8_t>(fc | 0x80), exc };
            ex.exception = exc;
            ++m_exceptions;
        }
        if (!broadcast) {
            const std::uint16_t crc = modbus_crc(rsp.data(), rsp.size());
            rsp.push_back(static_cast<std::uint8_t>(crc & 0xFF));
            rsp.push_back(static_cast<std::uint8_t>(crc >> 8));
            ex.tx = hex(rsp.data(), rsp.size());
            log_frame("TX", rsp.data(), rsp.size(), response_text(rsp.data(), rsp.size()), exc != 0);
            boost::system::error_code ec;
            boost::asio::write(*m_port, boost::asio::buffer(rsp), ec);
            if (ec) {
                ex.detail["error"] = ec.message();
                log_exchange(std::move(ex));
                on_failure("write: " + ec.message());
                return;
            }
        }
        log_exchange(std::move(ex));
    }

    void AModbusModule::housekeeping() {
        if (!m_active.load()) {
            return;
        }
        const std::int64_t last = m_last_master_mono.load();
        if (m_master_online && mono_ms() - last > MASTER_SILENCE_MS) {
            m_master_online = false;
            ULog::warn(TAG, "Master silent for " + std::to_string(MASTER_SILENCE_MS / 1000) + " s");
        }
        m_housekeeping_timer.expires_after(std::chrono::seconds(HOUSEKEEPING_SEC));
        m_housekeeping_timer.async_wait([this](const boost::system::error_code& ec) {
            if (!ec) {
                housekeeping();
            }
        });
    }

    void AModbusModule::log_exchange(FExchange ex) {
        std::lock_guard<std::mutex> lock(m_log_mutex);
        ex.seq = ++m_seq;
        ex.ts = now_ms();
        m_log.push_back(std::move(ex));
        if (m_log.size() > LOG_CAPACITY) {
            m_log.pop_front();
        }
    }

    boost::json::object AModbusModule::to_json() const {
        const FModbusConfig cfg = config();
        const std::int64_t now = mono_ms();
        const bool is_connected = m_connected.load();

        json::object connection;
        connection["connected"] = is_connected;
        connection["enabled"] = cfg.enabled;
        connection["url"] = describe(cfg);
        connection["device"] = cfg.device;
        connection["baud"] = cfg.baud;
        connection["parity"] = cfg.parity;
        connection["data_bits"] = cfg.data_bits;
        connection["stop_bits"] = cfg.stop_bits;
        connection["error"] = is_connected ? std::string() : error();
        connection["phase"] = is_connected ? "connected"
            : (!cfg.enabled || !m_active.load()) ? "off"
            : (m_waiting.load() ? "waiting" : "connecting");
        connection["attempt"] = m_attempt.load();
        const std::int64_t next = m_next_retry_mono.load();
        connection["retry_in_ms"] = next > now ? next - now : 0;

        const std::int64_t last = m_last_master_mono.load();
        json::object master;
        master["online"] = last != 0 && now - last <= MASTER_SILENCE_MS;
        master["age_ms"] = last ? now - last : -1;

        json::object counters;
        counters["requests"] = m_requests.load();
        counters["broadcasts"] = m_broadcasts.load();
        counters["exceptions"] = m_exceptions.load();
        counters["crc_errors"] = m_crc_errors.load();
        counters["garbage_bytes"] = m_garbage.load();
        counters["foreign"] = m_foreign.load();
        counters["foreign_last"] = m_foreign_last.load();

        json::array log;
        {
            std::lock_guard<std::mutex> lock(m_log_mutex);
            for (auto it = m_log.rbegin(); it != m_log.rend(); ++it) {
                json::object e;
                e["seq"] = it->seq;
                e["ts"] = it->ts;
                e["address"] = it->address;
                e["function"] = it->function;
                e["reg"] = it->reg;
                e["count"] = it->count;
                e["exception"] = it->exception;
                e["kind"] = it->kind;
                e["rx"] = it->rx;
                e["tx"] = it->tx;
                e["detail"] = it->detail;
                log.push_back(std::move(e));
            }
        }

        json::object m;
        m["id"] = id();
        m["title"] = title();
        m["transport"] = transport();
        m["heartbeat_sec"] = 0;
        m["protocol_versions"] = json::array{};
        m["connection"] = std::move(connection);
        m["slave"] = json::object{ {"address", cfg.slave} };
        m["master"] = std::move(master);
        m["counters"] = std::move(counters);
        m["log"] = std::move(log);
        m["stats"] = m_stats.to_json();
        status(m);
        return m;
    }

    boost::json::object AModbusModule::config_snapshot() const {
        return varan::gateway::to_json(config());
    }

    bool AModbusModule::apply_config(const json::object& patch, std::string& err) {
        FModbusConfig updated = config();
        if (!varan::gateway::apply_json(updated, patch, err)) {
            return false;
        }
        bool port_changed = false;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            port_changed = m_config.device != updated.device || m_config.baud != updated.baud ||
                m_config.parity != updated.parity || m_config.data_bits != updated.data_bits ||
                m_config.stop_bits != updated.stop_bits || m_config.enabled != updated.enabled;
            m_config = updated;
        }
        // Порт переоткрывается только при смене того, что его определяет
        if (port_changed && m_active.load()) {
            boost::asio::post(m_ioc, [this] {
                m_retry_timer.cancel();
                close_port();
                m_attempt = 0;
                try_open();
            });
        }
        ULog::info(TAG, "Reconfigured -> " + describe(updated) + ", slave " + std::to_string(updated.slave));
        return true;
    }

} // namespace gateway
} // namespace varan
