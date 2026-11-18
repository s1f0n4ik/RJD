#include "gateway/core/kzt-integration.h"
#include "gateway/core/neural-health.h"
#include "gateway/utility/clock.h"
#include "gateway/utility/log.h"

#include <chrono>

namespace varan {
    namespace gateway {

        namespace json = boost::json;

        namespace {

            const char* TAG = "integration:kzt";
            const char* MODULE_TAG = "module:modbus";

            std::string list_text(const std::vector<int>& v) {
                std::string s;
                for (int x : v) {
                    s += (s.empty() ? "" : ",") + std::to_string(x);
                }
                return s.empty() ? "—" : s;
            }

        } // namespace

        void UKztPacket::stamp(std::vector<std::uint16_t>& regs, std::int64_t utc_ms) const {
            put_unix(regs, 3, utc_ms);
        }

        std::vector<std::uint16_t> UKztPacket::build(const FKztState& state, bool working, const FTimeGpsSnapshot& gps) const {
            auto regs = blank();
            regs[2] = 1;
            if (gps.valid) {
                put_angle(regs, 7, gps.lat);
                put_angle(regs, 10, gps.lon);
                regs[13] = gps.lon < 0 ? 'W' : 'E';
                regs[14] = gps.lat < 0 ? 'S' : 'N';
            }
            for (std::size_t i = 0; i < 3 && i < state.attachments.size(); ++i) {
                regs[15 + i] = static_cast<std::uint16_t>(state.attachments[i]);
            }
            for (std::size_t i = 0; i < 3 && i < state.cargo.size(); ++i) {
                regs[18 + i] = static_cast<std::uint16_t>(state.cargo[i]);
            }
            regs[21] = working ? 1 : 0;
            return regs;
        }

        std::vector<FPacketField> UKztPacket::describe(const std::vector<std::uint16_t>& regs) const {
            const auto letter = [](std::uint16_t v) { return v ? std::string(1, static_cast<char>(v)) : std::string("—"); };
            const std::int64_t unix_s = get_unix(regs, 3);

            std::vector<FPacketField> f = header(regs);
            f.push_back({ "Тип", 2, 1, "service", std::to_string(regs[2]) });
            f.push_back({ "Время UTC", 3, 4, "time", utc_text(unix_s, "%H:%M:%S"), utc_text(unix_s, "%d.%m.%Y") });
            f.push_back({ "Широта", 7, 3, "geo", angle_text(regs, 7) });
            f.push_back({ "Долгота", 10, 3, "geo", angle_text(regs, 10) });
            f.push_back({ "E/W", 13, 1, "geo", letter(regs[13]) });
            f.push_back({ "N/S", 14, 1, "geo", letter(regs[14]) });
            // Коды навесного — ключи словаря мастера
            for (int i = 0; i < 3; ++i) {
                f.push_back({ "Навесное " + std::to_string(i + 1), 15 + i, 1, "detection", std::to_string(regs[15 + i]), "", "attachment", true });
            }
            for (int i = 0; i < 3; ++i) {
                f.push_back({ "Груз " + std::to_string(i + 1), 18 + i, 1, "detection", std::to_string(regs[18 + i]), "", "", true });
            }
            f.push_back({ "Работа", 21, 1, "detection", regs[21] ? "да" : "нет", "", "", true });
            f.push_back({ "Резерв", 22, 10, "reserved", "—" });
            return f;
        }

        UKztModbusModule::UKztModbusModule(boost::asio::io_context& ioc, FModbusConfig config,
            UTimeSource& time_source, std::string queue_file)
            : AKrspsModule(ioc, std::move(config), std::move(queue_file))
            , m_time(time_source)
        {
            m_reason = json::object{ {"code", "unknown"} };
            m_sent_mono = mono_ms();
        }

        FSubmitResult UKztModbusModule::handle_frame(const FFrameMessage& msg) {
            FSubmitResult result;
            result.ver = msg.ver;
            result.transport = "modbus";
            result.status = ESubmitStatus::Accepted;
            if (!msg.kzt) {
                return result;
            }

            std::lock_guard<std::mutex> lock(m_state_mutex);
            m_camera_id = msg.camera_id;
            // Повтор того же состава (досылка мастера) пакет не пишет
            if (*msg.kzt == m_state) {
                return result;
            }
            m_state = *msg.kzt;
            send("composition");
            m_stats.on_frame_sent(msg.id, now_ms(), msg.ver, 1, m_packet.length() * 2, false);
            result.wire_size = m_packet.length() * 2;
            return result;
        }

        void UKztModbusModule::send(const char* why) {
            const FModbusRecord r = enqueue(m_packet, m_packet.build(m_state, m_working == 1, m_time.snapshot_struct()));
            m_sent_mono = mono_ms();
            ULog::info(MODULE_TAG, "Record #" + std::to_string(r.number) + " queued (" + why + "): attachments " +
                list_text(m_state.attachments) + ", cargo " + list_text(m_state.cargo) + ", working " + std::to_string(m_working) +
                (r.hidden ? " (hidden until master time)" : ""));
        }

        void UKztModbusModule::tick() {
            std::lock_guard<std::mutex> lock(m_state_mutex);
            const int period_s = m_state.period_s > 0 ? m_state.period_s : DEFAULT_PERIOD_S;
            if (mono_ms() - m_sent_mono >= static_cast<std::int64_t>(period_s) * 1000) {
                send("period");
            }
        }

        std::string UKztModbusModule::camera_id() const {
            std::lock_guard<std::mutex> lock(m_state_mutex);
            return m_camera_id;
        }

        void UKztModbusModule::set_state(std::uint16_t value, json::object reason) {
            std::lock_guard<std::mutex> lock(m_state_mutex);
            const std::int64_t now = mono_ms();
            std::uint16_t working = 1;
            if (value == 1) {
                m_fail_since = 0;
            }
            else {
                if (!m_fail_since) {
                    m_fail_since = now;
                }
                working = now - m_fail_since >= WORK_HOLD_MS ? 0 : m_working;
            }
            if (reason != m_reason) {
                ULog::info(MODULE_TAG, "Vision state " + std::to_string(value) + ": " + json::serialize(reason));
            }
            m_reason = std::move(reason);
            if (working != m_working) {
                ULog::info(MODULE_TAG, "Work flag " + std::to_string(m_working) + " -> " + std::to_string(working));
                m_working = working;
                send("work flag");
            }
        }

        std::vector<FStateRegister> UKztModbusModule::state_registers() const {
            std::lock_guard<std::mutex> lock(m_state_mutex);
            FStateRegister s;
            s.value = m_working;
            s.label = "работа";
            s.ok = m_working == 1;
            s.code = neural_health::str(m_reason, "code");
            s.reason = neural_health::reason_parts(m_reason);
            s.error = neural_health::str(m_reason, "error");
            return { s };
        }

        std::int64_t UKztModbusModule::on_master_time(std::int64_t unix_s) {
            return m_time.update_time(unix_s * 1000, "modbus");
        }

        void UKztModbusModule::on_master_gps(double lat, double lon) {
            m_time.update_gps(lat, lon, 0.0, "modbus", MASTER_SILENCE_MS);
        }

        UKztIntegration::UKztIntegration(boost::asio::io_context& ioc, FModbusConfig modbus,
            UTimeSource& time_source, std::string queue_file, std::string backend_url)
            : m_modbus(std::make_shared<UKztModbusModule>(ioc, std::move(modbus), time_source, std::move(queue_file)))
            , m_backend_url(std::move(backend_url))
        {}

        UKztIntegration::~UKztIntegration() {
            stop_poller();
        }

        std::shared_ptr<IModule> UKztIntegration::find_module(const std::string& id) const {
            return id == m_modbus->id() ? m_modbus : nullptr;
        }

        void UKztIntegration::start() {
            m_modbus->start();
            {
                std::lock_guard<std::mutex> lock(m_poll_mutex);
                if (m_polling) {
                    return;
                }
                m_polling = true;
            }
            if (m_poller.joinable()) {
                m_poller.join();
            }
            m_poller = std::thread([this] { poll_loop(); });
            ULog::info(TAG, "Started, state from " + m_backend_url + "/api/neural/status");
        }

        void UKztIntegration::stop() {
            stop_poller();
            m_modbus->stop();
            ULog::info(TAG, "Stopped");
        }

        void UKztIntegration::stop_poller() {
            {
                std::lock_guard<std::mutex> lock(m_poll_mutex);
                m_polling = false;
            }
            m_poll_cv.notify_all();
            if (m_poller.joinable()) {
                m_poller.join();
            }
        }

        bool UKztIntegration::connected() const {
            return m_modbus->connected();
        }

        FSubmitResult UKztIntegration::handle_frame(const FFrameMessage& msg) {
            if (!msg.addressed_to(m_modbus->id())) {
                FSubmitResult result;
                result.ver = msg.ver;
                result.status = ESubmitStatus::NotConnected;
                result.error = "no delivery modules";
                return result;
            }
            return m_modbus->handle_frame(msg);
        }

        // Опрос техзрения раз в STATE_POLL_SEC, повтор состава — каждую секунду
        void UKztIntegration::poll_loop() {
            auto polled = std::chrono::steady_clock::time_point{};
            std::unique_lock<std::mutex> lock(m_poll_mutex);
            while (m_polling) {
                lock.unlock();
                const auto now = std::chrono::steady_clock::now();
                if (now - polled >= std::chrono::seconds(STATE_POLL_SEC)) {
                    polled = now;
                    json::object reason;
                    const std::uint16_t value = neural_health::poll(m_backend_url, m_modbus->camera_id(), reason);
                    m_modbus->set_state(value, std::move(reason));
                }
                m_modbus->tick();

                lock.lock();
                m_poll_cv.wait_for(lock, std::chrono::seconds(1), [this] { return !m_polling; });
            }
        }

        boost::json::object UKztIntegration::config_json() const {
            json::object o;
            o["id"] = id();
            o["title"] = title();
            o["description"] = description();
            o["modules"] = json::array{ m_modbus->to_json() };
            return o;
        }

        boost::json::object UKztIntegration::status_json() const {
            return config_json();
        }

    } // namespace gateway
} // namespace varan
