#include "gateway/rsm2000-integration.h"
#include "gateway/frame-codec-v1.h"
#include "gateway/log.h"

namespace varan {
    namespace gateway {

        namespace json = boost::json;

        namespace {
            const char* TAG = "integration:rsm-2000";
        }

        URsm2000Integration::URsm2000Integration(boost::asio::io_context& ioc, FWsConfig ws, int heartbeat_sec)
            : m_ioc(ioc)
            , m_heartbeat_timer(ioc)
            , m_heartbeat_sec(heartbeat_sec)
        {
            m_registry.register_codec(std::make_shared<UFrameCodecV1>());
            m_ws = std::make_shared<UWsTransport>(m_ioc, std::move(ws));
        }

        void URsm2000Integration::start() {
            if (m_active.exchange(true)) {
                return;
            }
            m_ws->connect();
            // Таймер живёт на m_ioc; трогаем его только из потока этого ioc, чтобы
            // не ловить гонку при вызове start() из REST-потока.
            boost::asio::post(m_ioc, [this] { start_heartbeat(); });
            ULog::info(TAG, "Started");
        }

        void URsm2000Integration::stop() {
            if (!m_active.exchange(false)) {
                return;
            }
            boost::asio::post(m_ioc, [this] { m_heartbeat_timer.cancel(); });
            m_ws->disconnect();
            ULog::info(TAG, "Stopped");
        }

        bool URsm2000Integration::connected() const {
            return m_ws->connected();
        }

        FSubmitResult URsm2000Integration::handle_frame(const FFrameMessage& msg) {
            FSubmitResult result;
            result.ver = msg.ver;

            const std::int64_t ts_recv = now_ms();
            const int det_count = static_cast<int>(msg.dets.size());

            auto codec = m_registry.find(msg.ver);
            if (!codec) {
                result.status = ESubmitStatus::UnsupportedVersion;
                result.error = "unsupported message version";
                result.supported = m_registry.versions();
                m_stats.on_frame_rejected(msg.id, ts_recv, msg.ver, det_count, result.error);
                return result;
            }

            auto encoded = codec->encode_frame(msg);
            if (!encoded.ok) {
                result.status = ESubmitStatus::EncodeError;
                result.error = encoded.error;
                m_stats.on_frame_rejected(msg.id, ts_recv, msg.ver, det_count, result.error);
                return result;
            }

            if (!m_ws->connected()) {
                result.status = ESubmitStatus::NotConnected;
                result.error = "websocket not connected";
                m_stats.on_frame_rejected(msg.id, ts_recv, msg.ver, det_count, result.error);
                return result;
            }

            const std::int64_t wire_size = static_cast<std::int64_t>(encoded.wire.size());
            m_ws->send(encoded.wire, encoded.binary);
            m_last_send_ms = now_ms();

            m_stats.on_frame_sent(msg.id, ts_recv, msg.ver, det_count, wire_size, !msg.image.empty());

            result.status = ESubmitStatus::Accepted;
            result.transport = m_ws->name();
            result.wire_size = wire_size;
            return result;
        }

        void URsm2000Integration::start_heartbeat() {
            const int period = m_heartbeat_sec.load();
            if (period <= 0 || !m_active.load()) {
                return;
            }

            m_heartbeat_timer.expires_after(std::chrono::seconds(period));
            m_heartbeat_timer.async_wait([this, period](const boost::system::error_code& ec) {
                if (ec || !m_active.load()) {
                    return;
                }
                // Heartbeat только при живом соединении и простое канала period секунд.
                if (m_ws->connected()) {
                    const std::int64_t idle = now_ms() - m_last_send_ms.load();
                    if (idle >= static_cast<std::int64_t>(period) * 1000) {
                        auto versions = m_registry.versions();
                        if (!versions.empty()) {
                            auto codec = m_registry.find(versions.back());
                            const std::int64_t ts = now_ms();
                            std::string wire = codec->encode_heartbeat(ts);
                            const std::int64_t wire_size = static_cast<std::int64_t>(wire.size());
                            m_ws->send(wire, false);
                            m_last_send_ms = ts;
                            m_stats.on_heartbeat_sent(ts, versions.back(), wire_size);
                        }
                    }
                }
                start_heartbeat();
            });
        }

        boost::json::object URsm2000Integration::module_json() const {
            auto cfg = m_ws->config();

            json::object connection;
            connection["connected"] = m_ws->connected();
            connection["enabled"] = cfg.enabled;
            connection["url"] = "ws://" + cfg.host + ":" + cfg.port + cfg.target;
            connection["host"] = cfg.host;
            connection["port"] = cfg.port;
            connection["target"] = cfg.target;

            json::array versions;
            for (int v : m_registry.versions()) {
                versions.push_back(v);
            }

            json::object m;
            m["id"] = "websocket";
            m["title"] = "WebSocket";
            m["transport"] = "websocket";
            m["heartbeat_sec"] = m_heartbeat_sec.load();
            m["protocol_versions"] = std::move(versions);
            m["connection"] = std::move(connection);
            m["stats"] = m_stats.to_json();
            return m;
        }

        // Конверт конфигурации: перечень её модулей. Сейчас модуль один (WebSocket);
        // при добавлении CAN/Modbus в набор конфигурации массив modules расширяется.
        boost::json::object URsm2000Integration::config_json() const {
            json::array modules;
            modules.push_back(module_json());

            json::object o;
            o["id"] = id();
            o["title"] = title();
            o["description"] = description();
            o["modules"] = std::move(modules);
            return o;
        }

        boost::json::object URsm2000Integration::status_json() const {
            return config_json();
        }

        bool URsm2000Integration::apply_config(const boost::json::object& patch, std::string& err) {
            FWsConfig updated = m_ws->config();
            if (!apply_json(updated, patch, err)) {
                return false;
            }
            if (auto* v = patch.if_contains("heartbeat_sec")) {
                try {
                    m_heartbeat_sec = static_cast<int>(v->to_number<int>());
                }
                catch (const std::exception& e) {
                    err = e.what();
                    return false;
                }
            }

            m_ws->reconfigure(updated);
            ULog::info(TAG, "Reconfigured -> ws://" + updated.host + ":" + updated.port + updated.target);
            return true;
        }

    } // namespace gateway
} // namespace varan
