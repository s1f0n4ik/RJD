#include "gateway/core/iskra-integration.h"
#include "gateway/utility/clock.h"
#include "gateway/utility/log.h"

#include <chrono>
#include <cstdio>

#include <boost/beast.hpp>

namespace varan {
    namespace gateway {

        namespace json = boost::json;

        namespace {

            const char* TAG = "integration:iskra";
            constexpr int HTTP_TIMEOUT_SEC = 8;

            std::string str(const json::object& o, const char* key) {
                const auto* v = o.if_contains(key);
                return v && v->is_string() ? std::string(v->as_string()) : std::string();
            }

            // GET base + path, base вида http://host:port[/prefix]
            bool http_get(const std::string& base, const std::string& path, std::string& body, std::string& err) {
                namespace beast = boost::beast;
                namespace http = beast::http;
                namespace asio = boost::asio;

                std::string rest = base.rfind("http://", 0) == 0 ? base.substr(7) : base;
                const auto slash = rest.find('/');
                std::string prefix = slash == std::string::npos ? std::string() : rest.substr(slash);
                if (!prefix.empty() && prefix.back() == '/') {
                    prefix.pop_back();
                }
                const std::string hostport = rest.substr(0, slash);
                const auto colon = hostport.rfind(':');
                const std::string host = colon == std::string::npos ? hostport : hostport.substr(0, colon);
                const std::string port = colon == std::string::npos ? "80" : hostport.substr(colon + 1);

                asio::io_context ioc;
                asio::ip::tcp::resolver resolver(ioc);
                beast::tcp_stream stream(ioc);
                http::request<http::empty_body> req{ http::verb::get, prefix + path, 11 };
                req.set(http::field::host, host);
                req.set(http::field::user_agent, "message-gateway");
                beast::flat_buffer buffer;
                http::response<http::string_body> res;
                beast::error_code result;

                stream.expires_after(std::chrono::seconds(HTTP_TIMEOUT_SEC));
                resolver.async_resolve(host, port,
                    [&](const beast::error_code& ec, const asio::ip::tcp::resolver::results_type& results) {
                        if (ec) {
                            result = ec;
                            return;
                        }
                        stream.async_connect(results, [&](const beast::error_code& ec, const asio::ip::tcp::endpoint&) {
                            if (ec) {
                                result = ec;
                                return;
                            }
                            http::async_write(stream, req, [&](const beast::error_code& ec, std::size_t) {
                                if (ec) {
                                    result = ec;
                                    return;
                                }
                                http::async_read(stream, buffer, res,
                                    [&](const beast::error_code& ec, std::size_t) { result = ec; });
                            });
                        });
                    });
                ioc.run();

                if (result) {
                    err = result.message();
                    return false;
                }
                if (res.result() != http::status::ok) {
                    err = "HTTP " + std::to_string(res.result_int());
                    return false;
                }
                body = std::move(res.body());
                beast::error_code ignore;
                stream.socket().shutdown(asio::ip::tcp::socket::shutdown_both, ignore);
                return true;
            }

            const char* MODULE_TAG = "module:modbus";

            // Коды обнаружения 0–10, зоны 1–3, роли камер по битам маски 1–4
            const char* const CODES[] = {
                "Человек, не удалось распознать наличие СИЗ", "Человек в СИЗ", "Человек без СИЗа",
                "Легковая автомобильная техника", "Грузовая автомобильная техника", "Строительная техника",
                "Сыпучие отходы производства", "Твёрдые отходы производства", "Железнодорожная шпала (мусор)",
                "Граффити", "Борщевик" };
            const char* const ZONES[] = { "", "На пути", "Опасная близость", "Полоса отвода" };
            const char* const ROLES[] = { "дальняя", "ближняя", "левая", "правая" };

            std::int64_t num(const json::object& o, const char* key) {
                const auto* v = o.if_contains(key);
                return v && v->is_number() ? v->to_number<std::int64_t>() : 0;
            }

            std::string plural(std::int64_t n, const char* one, const char* few, const char* many) {
                const std::int64_t a = n % 100;
                const std::int64_t b = n % 10;
                return std::to_string(n) + " " + (a > 10 && a < 20 ? many : b == 1 ? one : (b > 1 && b < 5) ? few : many);
            }

            // Причина регистра 0x1007 по частям для страницы
            std::vector<std::string> reason_parts(const json::object& r) {
                const std::string code = str(r, "code");
                std::string dev = str(r, "device");
                if (dev.empty()) {
                    dev = "—";
                }
                if (code == "ok") {
                    return { plural(num(r, "devices"), "плата", "платы", "плат"),
                        plural(num(r, "slots"), "слот", "слота", "слотов"),
                        plural(num(r, "tiles"), "камера", "камеры", "камер") };
                }
                if (code == "unknown") return { "не проверялось" };
                if (code == "backend_unavailable") return { "бэкенд недоступен" };
                if (code == "no_devices") return { "нет плат техзрения" };
                if (code == "device_offline") return { dev + " не в сети" };
                if (code == "no_module") return { dev, "нет модуля техзрения" };
                if (code == "no_slots") return { dev, "слотов нет" };
                if (code == "slot_stopped") return { dev, "слот " + str(r, "stream") + " остановлен" };
                if (code == "no_tiles") return { dev, "слот " + str(r, "stream") + " без камер" };
                if (code == "tile_fault") {
                    const std::string tile = str(r, "tile_state");
                    return { dev, "камера " + str(r, "camera"),
                        tile == "no_camera" ? "камеры нет в хранилище" : tile == "stalled" ? "кадр замёрз" : tile };
                }
                return { code };
            }

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
            std::string roles;
            for (int i = 0; i < 4; ++i) {
                if (regs[18] & (1 << i)) {
                    cameras += (cameras.empty() ? "" : ", ") + std::to_string(i + 1);
                    roles += (roles.empty() ? "" : ", ") + std::string(ROLES[i]);
                }
            }

            std::vector<FPacketField> f = header(regs);
            f.push_back({ "Тип", 2, 1, "service", std::to_string(regs[2]) });
            f.push_back({ "Время UTC", 3, 4, "time", utc_text(unix_s, "%H:%M:%S"), utc_text(unix_s, "%d.%m.%Y") });
            f.push_back({ "Широта", 7, 3, "geo", angle_text(regs, 7) });
            f.push_back({ "Долгота", 10, 3, "geo", angle_text(regs, 10) });
            f.push_back({ "E/W", 13, 1, "geo", letter(regs[13]) });
            f.push_back({ "N/S", 14, 1, "geo", letter(regs[14]) });
            f.push_back({ "Код", 15, 1, "detection", std::to_string(regs[15]), "", regs[15] < 11 ? CODES[regs[15]] : "", true });
            f.push_back({ "Стоп-кадр", 16, 2, "frame", std::to_string(frame), "", "", true });
            f.push_back({ "Камеры", 18, 1, "detection", cameras.empty() ? "—" : cameras, "", roles, true });
            f.push_back({ "Зона", 19, 1, "detection", std::to_string(regs[19]), "", regs[19] < 4 ? ZONES[regs[19]] : "", true });
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
            s.code = str(m_state_reason, "code");
            s.reason = reason_parts(m_state_reason);
            s.error = str(m_state_reason, "error");
            return { s };
        }

        void UIskraModbusModule::on_master_time(std::int64_t unix_s) {
            m_time.update_time(unix_s * 1000, "modbus");
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
                std::uint16_t value = 0;
                std::string body;
                std::string err;
                if (!http_get(m_backend_url, "/api/neural/status", body, err)) {
                    reason = json::object{ {"code", "backend_unavailable"}, {"error", err} };
                }
                else {
                    boost::system::error_code ec;
                    const json::value parsed = json::parse(body, ec);
                    if (ec) {
                        reason = json::object{ {"code", "backend_unavailable"}, {"error", "invalid json"} };
                    }
                    else {
                        value = evaluate(parsed, reason);
                    }
                }
                m_modbus->set_state(value, std::move(reason));

                lock.lock();
                m_poll_cv.wait_until(lock, started + std::chrono::seconds(STATE_POLL_SEC),
                    [this] { return !m_polling; });
            }
        }

        std::uint16_t UIskraIntegration::evaluate(const json::value& body, json::object& reason) {
            const json::array* devices = nullptr;
            if (const auto* o = body.if_object()) {
                if (const auto* data = o->if_contains("data"); data && data->is_object()) {
                    if (const auto* list = data->as_object().if_contains("devices"); list && list->is_array()) {
                        devices = &list->as_array();
                    }
                }
            }
            if (!devices) {
                reason = json::object{ {"code", "backend_unavailable"}, {"error", "no data.devices"} };
                return 0;
            }
            if (devices->empty()) {
                reason = json::object{ {"code", "no_devices"} };
                return 0;
            }

            std::size_t slots_total = 0;
            std::size_t tiles_total = 0;
            for (const auto& dv : *devices) {
                const json::object empty;
                const json::object& d = dv.is_object() ? dv.as_object() : empty;
                std::string device = str(d, "device_name");
                if (device.empty()) {
                    device = str(d, "device_id");
                }
                const std::string state = str(d, "state");
                if (state != "ok") {
                    reason = json::object{ {"code", state == "no_module" ? "no_module" : "device_offline"}, {"device", device} };
                    return 0;
                }
                const auto* slots = d.if_contains("slots");
                if (!slots || !slots->is_array() || slots->as_array().empty()) {
                    reason = json::object{ {"code", "no_slots"}, {"device", device} };
                    return 0;
                }
                for (const auto& sv : slots->as_array()) {
                    const json::object& s = sv.is_object() ? sv.as_object() : empty;
                    const std::string stream = str(s, "stream_id");
                    const auto* running = s.if_contains("running");
                    if (!running || !running->is_bool() || !running->as_bool()) {
                        reason = json::object{ {"code", "slot_stopped"}, {"device", device}, {"stream", stream}, {"error", str(s, "error")} };
                        return 0;
                    }
                    const auto* tiles = s.if_contains("tiles");
                    if (!tiles || !tiles->is_array() || tiles->as_array().empty()) {
                        reason = json::object{ {"code", "no_tiles"}, {"device", device}, {"stream", stream} };
                        return 0;
                    }
                    for (const auto& tv : tiles->as_array()) {
                        const json::object& t = tv.is_object() ? tv.as_object() : empty;
                        const std::string tile = str(t, "state");
                        if (tile != "ok") {
                            reason = json::object{ {"code", "tile_fault"}, {"device", device}, {"stream", stream},
                                {"camera", str(t, "camera")}, {"tile_state", tile} };
                            return 0;
                        }
                    }
                    ++slots_total;
                    tiles_total += tiles->as_array().size();
                }
            }
            reason = json::object{ {"code", "ok"}, {"devices", devices->size()}, {"slots", slots_total}, {"tiles", tiles_total} };
            return 1;
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
