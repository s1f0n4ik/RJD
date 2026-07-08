#include "gateway/gateway.h"
#include "gateway/frame-codec-v1.h"
#include "gateway/grpc-ingress.h"
#include "gateway/log.h"

#include <chrono>

#include <boost/json.hpp>

namespace varan {
    namespace gateway {

        namespace json = boost::json;
        namespace http = boost::beast::http;

        namespace {

            const char* TAG = "gateway";

            URouter::FResponse make_json(const URouter::FRequest& req, http::status status, const json::value& body) {
                URouter::FResponse res{ status, req.version() };
                res.set(http::field::content_type, "application/json");
                res.body() = json::serialize(body);
                res.prepare_payload();
                return res;
            }

            URouter::FResponse make_error(const URouter::FRequest& req, http::status status, const std::string& msg) {
                return make_json(req, status, json::object{ {"error", msg} });
            }

        } // namespace

        UGateway::UGateway(FGatewayConfig config)
            : m_config(std::move(config))
        {
            setup_codecs();
            m_ws = std::make_shared<UWsTransport>(m_ws_ioc, m_config.ws);
            m_router = std::make_shared<URouter>();
            setup_routes();
            m_grpc = std::make_unique<UGrpcIngress>(*this, m_config.grpc_port);
        }

        UGateway::~UGateway() {
            stop();
        }

        void UGateway::setup_codecs() {
            m_registry.register_codec(std::make_shared<UFrameCodecV1>());
        }

        void UGateway::setup_routes() {
            m_router->add_route(http::verb::get, "/health",
                [this](const auto& r) { return handle_health(r); });

            m_router->add_route(http::verb::get, "/config",
                [this](const auto& r) { return handle_get_config(r); });
            m_router->add_route(http::verb::put, "/config/websocket",
                [this](const auto& r) { return handle_put_ws_config(r); });

            m_router->add_route(http::verb::post, "/ws/connect",
                [this](const auto& r) { return handle_ws_connect(r); });
            m_router->add_route(http::verb::post, "/ws/disconnect",
                [this](const auto& r) { return handle_ws_disconnect(r); });
            m_router->add_route(http::verb::get, "/ws/status",
                [this](const auto& r) { return handle_ws_status(r); });

            m_router->add_route(http::verb::get, "/protocol/versions",
                [this](const auto& r) { return handle_versions(r); });
        }

        void UGateway::run() {
            if (m_running.exchange(true)) {
                return;
            }

            m_ws->connect();
            start_heartbeat();

            m_ws_thread = std::thread([this] {
                auto guard = boost::asio::make_work_guard(m_ws_ioc);
                m_ws_ioc.run();
            });

            m_grpc->start();

            auto endpoint = boost::asio::ip::tcp::endpoint(
                boost::asio::ip::tcp::v4(), m_config.rest_port);
            std::make_shared<UListener>(m_http_ioc, endpoint, m_router)->run();

            ULog::info(TAG, "REST server on port " + std::to_string(m_config.rest_port));
            m_http_ioc.run();
        }

        void UGateway::stop() {
            if (!m_running.exchange(false)) {
                return;
            }
            if (m_grpc) {
                m_grpc->stop();
            }
            m_ws->disconnect();
            m_heartbeat_timer.cancel();
            m_ws_ioc.stop();
            m_http_ioc.stop();
            if (m_ws_thread.joinable()) {
                m_ws_thread.join();
            }
        }

        void UGateway::start_heartbeat() {
            int period = 0;
            {
                std::lock_guard<std::mutex> lock(m_config_mutex);
                period = m_config.heartbeat_sec;
            }
            if (period <= 0) {
                return;
            }

            m_heartbeat_timer.expires_after(std::chrono::seconds(period));
            m_heartbeat_timer.async_wait([this, period](boost::beast::error_code ec) {
                if (ec) {
                    return;
                }
                // Heartbeat только когда есть соединение и канал простаивал period секунд.
                if (m_ws->connected()) {
                    std::int64_t idle = now_ms() - m_last_send_ms.load();
                    if (idle >= static_cast<std::int64_t>(period) * 1000) {
                        auto versions = m_registry.versions();
                        if (!versions.empty()) {
                            auto codec = m_registry.find(versions.back());
                            m_ws->send(codec->encode_heartbeat(now_ms()), false);
                            m_last_send_ms = now_ms();
                        }
                    }
                }
                start_heartbeat();
            });
        }

        URouter::FResponse UGateway::handle_health(const URouter::FRequest& req) {
            json::object o;
            o["status"] = "ok";
            o["ws_connected"] = m_ws->connected();
            return make_json(req, http::status::ok, o);
        }

        URouter::FResponse UGateway::handle_get_config(const URouter::FRequest& req) {
            std::lock_guard<std::mutex> lock(m_config_mutex);
            return make_json(req, http::status::ok, to_json(m_config));
        }

        URouter::FResponse UGateway::handle_put_ws_config(const URouter::FRequest& req) {
            boost::system::error_code ec;
            auto parsed = json::parse(req.body(), ec);
            if (ec || !parsed.is_object()) {
                return make_error(req, http::status::bad_request, "invalid json body");
            }

            FWsConfig updated;
            {
                std::lock_guard<std::mutex> lock(m_config_mutex);
                updated = m_config.ws;
            }

            std::string err;
            if (!apply_json(updated, parsed.as_object(), err)) {
                return make_error(req, http::status::bad_request, err);
            }

            {
                std::lock_guard<std::mutex> lock(m_config_mutex);
                m_config.ws = updated;
            }
            m_ws->reconfigure(updated);
            ULog::info(TAG, "WebSocket reconfigured -> ws://" + updated.host + ":" + updated.port + updated.target);

            return make_json(req, http::status::ok, to_json(updated));
        }

        URouter::FResponse UGateway::handle_ws_connect(const URouter::FRequest& req) {
            m_ws->connect();
            return make_json(req, http::status::ok, json::object{ {"status", "connecting"} });
        }

        URouter::FResponse UGateway::handle_ws_disconnect(const URouter::FRequest& req) {
            m_ws->disconnect();
            return make_json(req, http::status::ok, json::object{ {"status", "disconnected"} });
        }

        URouter::FResponse UGateway::handle_ws_status(const URouter::FRequest& req) {
            auto cfg = m_ws->config();
            json::object o;
            o["connected"] = m_ws->connected();
            o["config"] = to_json(cfg);
            return make_json(req, http::status::ok, o);
        }

        URouter::FResponse UGateway::handle_versions(const URouter::FRequest& req) {
            json::array arr;
            for (int v : m_registry.versions()) {
                arr.push_back(v);
            }
            return make_json(req, http::status::ok, json::object{ {"versions", arr} });
        }

        FSubmitResult UGateway::submit_frame(const FFrameMessage& msg) {
            FSubmitResult result;
            result.ver = msg.ver;

            auto codec = m_registry.find(msg.ver);
            if (!codec) {
                result.status = ESubmitStatus::UnsupportedVersion;
                result.error = "unsupported message version";
                result.supported = m_registry.versions();
                return result;
            }

            auto encoded = codec->encode_frame(msg);
            if (!encoded.ok) {
                result.status = ESubmitStatus::EncodeError;
                result.error = encoded.error;
                return result;
            }

            if (!m_ws->connected()) {
                result.status = ESubmitStatus::NotConnected;
                result.error = "websocket not connected";
                return result;
            }

            m_ws->send(encoded.wire, encoded.binary);
            m_last_send_ms = now_ms();

            result.status = ESubmitStatus::Accepted;
            result.transport = m_ws->name();
            result.wire_size = static_cast<std::int64_t>(encoded.wire.size());
            return result;
        }

        std::int64_t UGateway::now_ms() {
            return std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count();
        }

    } // namespace gateway
} // namespace varan
