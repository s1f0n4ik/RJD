#include "gateway/core/iskra-integration.h"
#include "gateway/core/neural-health.h"
#include "gateway/utility/clock.h"
#include "gateway/utility/log.h"

#include <chrono>
#include <cstdio>

namespace varan {
    namespace gateway {

        namespace json = boost::json;

        namespace {

            const char* TAG = "integration:iskra";
            const char* MODULE_TAG = "module:modbus";

        } // namespace

        void UIskraPacket28163::stamp(std::vector<std::uint16_t>& regs, std::int64_t utc_ms) const {
            put_unix(regs, 3, utc_ms);
        }

        std::vector<std::uint16_t> UIskraPacket28163::build(const FRecord& rec) const {
            auto regs = blank();
            regs[2] = 1;
            if (rec.gps_valid) {
                put_angle(regs, 7, rec.lat);
                put_angle(regs, 10, rec.lon);
                regs[13] = rec.lon < 0 ? 'W' : 'E';
                regs[14] = rec.lat < 0 ? 'S' : 'N';
            }
            regs[15] = static_cast<std::uint16_t>(rec.code);
            regs[16] = static_cast<std::uint16_t>(rec.frame_id);
            regs[17] = static_cast<std::uint16_t>(rec.frame_id >> 16);
            regs[18] = static_cast<std::uint16_t>(rec.camera_mask);
            regs[19] = static_cast<std::uint16_t>(rec.zone);
            regs[20] = static_cast<std::uint16_t>(rec.count);
            return regs;
        }

        std::vector<FPacketField> UIskraPacket28163::describe(const std::vector<std::uint16_t>& regs) const {
            const auto letter = [](std::uint16_t v) { return v ? std::string(1, static_cast<char>(v)) : std::string("—"); };
            const std::int64_t unix_s = get_unix(regs, 3);
            const std::uint32_t frame = static_cast<std::uint32_t>(regs[16]) | static_cast<std::uint32_t>(regs[17]) << 16;
            std::string cameras;
            for (int i = 0; i < 16; ++i) {
                if (regs[18] & (1 << i)) {
                    cameras += (cameras.empty() ? "" : ", ") + std::to_string(i + 1);
                }
            }

            std::vector<FPacketField> f = header(regs);
            f.push_back({ "Тип", 2, 1, "service", std::to_string(regs[2]) });
            f.push_back({ "Время UTC", 3, 4, "time", utc_text(unix_s, "%H:%M:%S"), utc_text(unix_s, "%d.%m.%Y") });
            f.push_back({ "Широта", 7, 3, "geo", angle_text(regs, 7) });
            f.push_back({ "Долгота", 10, 3, "geo", angle_text(regs, 10) });
            f.push_back({ "E/W", 13, 1, "geo", letter(regs[13]) });
            f.push_back({ "N/S", 14, 1, "geo", letter(regs[14]) });
            // Поле несёт ключ словаря мастера
            f.push_back({ "Код", 15, 1, "detection", std::to_string(regs[15]), "", "code", true });
            f.push_back({ "Стоп-кадр", 16, 2, "frame", std::to_string(frame), "", "", true });
            f.push_back({ "Камеры", 18, 1, "detection", cameras.empty() ? "—" : cameras, "", "cameras", true });
            f.push_back({ "Зона", 19, 1, "detection", std::to_string(regs[19]), "", "zone", true });
            f.push_back({ "Объектов", 20, 1, "detection", std::to_string(regs[20]), "", "", true });
            f.push_back({ "Резерв", 21, 11, "reserved", "—" });
            return f;
        }

        UIskraModbusModule::UIskraModbusModule(boost::asio::io_context& ioc, FModbusConfig config,
            UTimeSource& time_source, std::string queue_file)
            : AKrspsModule(ioc, std::move(config), std::move(queue_file))
            , m_time(time_source)
        {
            m_state_reason = json::object{ {"code", "unknown"} };
        }

        FSubmitResult UIskraModbusModule::handle_frame(const FFrameMessage& msg) {
            FSubmitResult result;
            result.ver = msg.ver;
            result.transport = "modbus";
            result.status = ESubmitStatus::Accepted;
            if (!msg.record) {
                return result;
            }

            FRecord rec = *msg.record;
            const FTimeGpsSnapshot snap = m_time.snapshot_struct();
            // Своих координат шлюз ставит, только если их нет в записи
            if (!rec.gps_valid && snap.valid) {
                rec.gps_valid = true;
                rec.lat = snap.lat;
                rec.lon = snap.lon;
            }
            // Время записи от мастера — в поясе шлюза, 0 — время приёма
            const std::int64_t utc_ms = rec.ts ? rec.ts - static_cast<std::int64_t>(snap.tz_offset_min) * 60000 : 0;
            const FModbusRecord r = enqueue(m_packet, m_packet.build(rec), utc_ms);

            char mask[8];
            std::snprintf(mask, sizeof(mask), "0x%X", rec.camera_mask & 0xFFFF);
            ULog::info(MODULE_TAG, "Record #" + std::to_string(r.number) + " queued: code " + std::to_string(rec.code) +
                ", zone " + std::to_string(rec.zone) + ", cameras " + mask + ", objects " + std::to_string(rec.count) +
                ", frame " + std::to_string(rec.frame_id) + (r.hidden ? " (hidden until master time)" : ""));
            m_stats.on_frame_sent(msg.id, now_ms(), msg.ver, 1, m_packet.length() * 2, false);
            result.wire_size = m_packet.length() * 2;
            return result;
        }

        void UIskraModbusModule::set_state(std::uint16_t value, json::object reason) {
            std::lock_guard<std::mutex> lock(m_state_mutex);
            if (m_state_value != value || reason != m_state_reason) {
                ULog::info(MODULE_TAG, "State register " + std::to_string(m_state_value) + " -> " + std::to_string(value) +
                    ": " + json::serialize(reason));
            }
            m_state_value = value;
            m_state_reason = std::move(reason);
        }

        std::vector<FStateRegister> UIskraModbusModule::state_registers() const {
            std::lock_guard<std::mutex> lock(m_state_mutex);
            FStateRegister s;
            s.value = m_state_value;
            s.label = "состояние";
            s.ok = m_state_value == 1;
            s.code = neural_health::str(m_state_reason, "code");
            s.reason = neural_health::reason_parts(m_state_reason);
            s.error = neural_health::str(m_state_reason, "error");
            return { s };
        }

        std::int64_t UIskraModbusModule::on_master_time(std::int64_t unix_s) {
            return m_time.update_time(unix_s * 1000, "modbus");
        }

        void UIskraModbusModule::on_master_gps(double lat, double lon) {
            m_time.update_gps(lat, lon, 0.0, "modbus", MASTER_SILENCE_MS);
        }

        UIskraIntegration::UIskraIntegration(boost::asio::io_context& ioc, FModbusConfig modbus,
            UTimeSource& time_source, std::string queue_file, std::string backend_url)
            : m_modbus(std::make_shared<UIskraModbusModule>(ioc, std::move(modbus), time_source, std::move(queue_file)))
            , m_backend_url(std::move(backend_url))
        {}

        UIskraIntegration::~UIskraIntegration() {
            stop_poller();
        }

        std::shared_ptr<IModule> UIskraIntegration::find_module(const std::string& id) const {
            return id == m_modbus->id() ? m_modbus : nullptr;
        }

        void UIskraIntegration::start() {
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

        void UIskraIntegration::stop() {
            stop_poller();
            m_modbus->stop();
            ULog::info(TAG, "Stopped");
        }

        void UIskraIntegration::stop_poller() {
            {
                std::lock_guard<std::mutex> lock(m_poll_mutex);
                m_polling = false;
            }
            m_poll_cv.notify_all();
            if (m_poller.joinable()) {
                m_poller.join();
            }
        }

        bool UIskraIntegration::connected() const {
            return m_modbus->connected();
        }

        FSubmitResult UIskraIntegration::handle_frame(const FFrameMessage& msg) {
            if (!msg.addressed_to(m_modbus->id())) {
                FSubmitResult result;
                result.ver = msg.ver;
                result.status = ESubmitStatus::NotConnected;
                result.error = "no delivery modules";
                return result;
            }
            return m_modbus->handle_frame(msg);
        }

        void UIskraIntegration::poll_loop() {
            std::unique_lock<std::mutex> lock(m_poll_mutex);
            while (m_polling) {
                lock.unlock();
                const auto started = std::chrono::steady_clock::now();
                json::object reason;
                const std::uint16_t value = neural_health::poll(m_backend_url, "", reason);
                m_modbus->set_state(value, std::move(reason));

                lock.lock();
                m_poll_cv.wait_until(lock, started + std::chrono::seconds(STATE_POLL_SEC),
                    [this] { return !m_polling; });
            }
        }

        boost::json::object UIskraIntegration::config_json() const {
            json::object o;
            o["id"] = id();
            o["title"] = title();
            o["description"] = description();
            o["modules"] = json::array{ m_modbus->to_json() };
            return o;
        }

        boost::json::object UIskraIntegration::status_json() const {
            return config_json();
        }

    } // namespace gateway
} // namespace varan
