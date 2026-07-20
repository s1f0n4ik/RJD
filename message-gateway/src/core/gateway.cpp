#include "gateway/core/gateway.h"
#include "gateway/core/rsm2000-integration.h"
#include "gateway/grpc/ingress.h"
#include "gateway/utility/devices.h"
#include "gateway/utility/log.h"

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
            , m_store(m_config.state_file)
        {
            setup_integrations();
            // Восстанавливаем до запуска модулей: apply_config при незапущенном
            // модуле только правит настройки и не трогает соединение.
            restore_state();
            m_router = std::make_shared<URouter>();
            setup_routes();
            m_grpc = std::make_unique<UGrpcIngress>(*this, m_config.grpc_port);
        }

        UGateway::~UGateway() {
            stop();
        }

        void UGateway::setup_integrations() {
            // Пока одна конфигурация — РСМ-2000 (модули WebSocket и CAN). Новые
            // добавляются push_back новой реализации IIntegration.
            auto rsm = std::make_shared<URsm2000Integration>(
                m_ws_ioc, m_config.ws, m_config.can, m_config.heartbeat_sec, m_taxonomy, m_time);
            m_integrations.push_back(rsm);
            m_active = rsm;
        }

        void UGateway::restore_state() {
            if (!m_store.enabled()) {
                return;
            }
            const json::object root = m_store.load();
            const auto* integrations = root.if_contains("integrations");
            if (!integrations || !integrations->is_object()) {
                return;
            }
            const json::object& all = integrations->as_object();

            for (const auto& it : m_integrations) {
                const auto* node = all.if_contains(it->id());
                if (!node || !node->is_object()) {
                    continue;
                }
                const json::object& obj = node->as_object();
                if (const auto* mods = obj.if_contains("modules"); mods && mods->is_object()) {
                    for (const auto& m : it->modules()) {
                        const auto* mc = mods->as_object().if_contains(m->id());
                        if (mc && mc->is_object()) {
                            std::string err;
                            if (!m->apply_config(mc->as_object(), err)) {
                                ULog::warn(TAG, "restore " + it->id() + "/" + m->id() + ": " + err);
                            }
                        }
                    }
                }
            }

            // Активная конфигурация из файла, если она ещё существует.
            if (const auto* a = root.if_contains("active"); a && a->is_string()) {
                if (auto t = find_integration(json::value_to<std::string>(*a))) {
                    std::lock_guard<std::mutex> lock(m_active_mutex);
                    m_active = t;
                }
            }

            // Таблица соответствий — общий объект, храним под активной конфигурацией.
            if (auto a = active()) {
                if (const auto* node = all.if_contains(a->id()); node && node->is_object()) {
                    if (const auto* tax = node->as_object().if_contains("taxonomy"); tax && tax->is_object()) {
                        std::string err;
                        if (!m_taxonomy.apply_json(tax->as_object(), err)) {
                            ULog::warn(TAG, "restore taxonomy: " + err);
                        }
                    }
                }
            }
            ULog::info(TAG, "Settings restored from " + m_config.state_file);
        }

        void UGateway::persist_state() {
            if (!m_store.enabled()) {
                return;
            }
            // Читаем текущий файл и правим только узлы своих интеграций, чтобы не
            // затереть настройки конфигураций, которых сейчас нет в памяти.
            json::object root = m_store.load();
            json::object integrations;
            if (const auto* ex = root.if_contains("integrations"); ex && ex->is_object()) {
                integrations = ex->as_object();
            }

            for (const auto& it : m_integrations) {
                json::object node;
                if (const auto* ex = integrations.if_contains(it->id()); ex && ex->is_object()) {
                    node = ex->as_object();  // сохраняем то, чего нет в памяти (напр. таблицу неактивной)
                }
                json::object modules;
                for (const auto& m : it->modules()) {
                    modules[m->id()] = m->config_snapshot();
                }
                node["modules"] = std::move(modules);
                integrations[it->id()] = std::move(node);
            }

            // Таблица соответствий пишется под активную конфигурацию.
            if (auto a = active()) {
                if (auto* node = integrations.if_contains(a->id()); node && node->is_object()) {
                    node->as_object()["taxonomy"] = m_taxonomy.to_json();
                }
            }

            root["active"] = active() ? active()->id() : "";
            root["integrations"] = std::move(integrations);
            m_store.save(root);
        }

        void UGateway::setup_routes() {
            m_router->add_route(http::verb::get, "/health",
                [this](const auto& r) { return handle_health(r); });

            m_router->add_route(http::verb::get, "/integrations",
                [this](const auto& r) { return handle_list_integrations(r); });
            m_router->add_route(http::verb::post, "/integrations/select",
                [this](const auto& r) { return handle_select_integration(r); });

            m_router->add_route(http::verb::get, "/status",
                [this](const auto& r) { return handle_status(r); });

            m_router->add_route(http::verb::get, "/config",
                [this](const auto& r) { return handle_get_config(r); });
            m_router->add_route(http::verb::put, "/config/websocket",
                [this](const auto& r) { return handle_put_module_config(r, "websocket"); });
            m_router->add_route(http::verb::put, "/config/can",
                [this](const auto& r) { return handle_put_module_config(r, "can"); });

            // Подключение отдельного модуля: тело { "module": "can" }.
            m_router->add_route(http::verb::post, "/modules/connect",
                [this](const auto& r) { return handle_module_connect(r, true); });
            m_router->add_route(http::verb::post, "/modules/disconnect",
                [this](const auto& r) { return handle_module_connect(r, false); });

            // Общая таблица соответствий: одна на весь шлюз, применяется всеми
            // модулями всех конфигураций.
            m_router->add_route(http::verb::get, "/taxonomy",
                [this](const auto& r) { return handle_get_taxonomy(r); });
            m_router->add_route(http::verb::put, "/taxonomy",
                [this](const auto& r) { return handle_put_taxonomy(r); });

            // Что видно на машине: интерфейсы CAN и serial-порты.
            m_router->add_route(http::verb::get, "/devices",
                [this](const auto& r) { return handle_devices(r); });

            m_router->add_route(http::verb::post, "/ws/connect",
                [this](const auto& r) { return handle_ws_connect(r); });
            m_router->add_route(http::verb::post, "/ws/disconnect",
                [this](const auto& r) { return handle_ws_disconnect(r); });
            m_router->add_route(http::verb::get, "/ws/status",
                [this](const auto& r) { return handle_ws_status(r); });

            m_router->add_route(http::verb::get, "/protocol/versions",
                [this](const auto& r) { return handle_versions(r); });

            m_router->add_route(http::verb::get, "/time",
                [this](const auto& r) { return handle_time(r); });
            m_router->add_route(http::verb::get, "/gps",
                [this](const auto& r) { return handle_time(r); });
        }

        void UGateway::run() {
            if (m_running.exchange(true)) {
                return;
            }

            if (auto a = active()) {
                a->start();
            }

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
            if (auto a = active()) {
                a->stop();
            }
            m_ws_ioc.stop();
            m_http_ioc.stop();
            if (m_ws_thread.joinable()) {
                m_ws_thread.join();
            }
        }

        std::shared_ptr<IIntegration> UGateway::active() const {
            std::lock_guard<std::mutex> lock(m_active_mutex);
            return m_active;
        }

        std::shared_ptr<IIntegration> UGateway::find_integration(const std::string& id) const {
            for (const auto& it : m_integrations) {
                if (it->id() == id) {
                    return it;
                }
            }
            return nullptr;
        }

        FSubmitResult UGateway::submit_frame(const FFrameMessage& msg) {
            auto a = active();
            if (!a) {
                FSubmitResult result;
                result.ver = msg.ver;
                result.status = ESubmitStatus::NotConnected;
                result.error = "no active integration";
                return result;
            }
            return a->handle_frame(msg);
        }

        URouter::FResponse UGateway::handle_health(const URouter::FRequest& req) {
            auto a = active();
            json::object o;
            o["status"] = "ok";
            o["ws_connected"] = a && a->connected();
            o["active"] = a ? a->id() : "";
            return make_json(req, http::status::ok, o);
        }

        URouter::FResponse UGateway::handle_list_integrations(const URouter::FRequest& req) {
            auto a = active();
            json::array items;
            for (const auto& it : m_integrations) {
                json::object o;
                o["id"] = it->id();
                o["title"] = it->title();
                o["description"] = it->description();
                o["connected"] = it->connected();

                // Краткий перечень модулей конфигурации для карточки (без статистики).
                json::array modules;
                auto cfg = it->config_json();
                if (auto* mods = cfg.if_contains("modules"); mods && mods->is_array()) {
                    for (const auto& mv : mods->as_array()) {
                        const auto& mo = mv.as_object();
                        json::object summary;
                        summary["id"] = mo.at("id");
                        summary["title"] = mo.at("title");
                        summary["transport"] = mo.at("transport");
                        modules.push_back(std::move(summary));
                    }
                }
                o["modules"] = std::move(modules);
                items.push_back(std::move(o));
            }
            json::object out;
            out["active"] = a ? a->id() : "";
            out["items"] = std::move(items);
            return make_json(req, http::status::ok, out);
        }

        URouter::FResponse UGateway::handle_select_integration(const URouter::FRequest& req) {
            boost::system::error_code ec;
            auto parsed = json::parse(req.body(), ec);
            if (ec || !parsed.is_object()) {
                return make_error(req, http::status::bad_request, "invalid json body");
            }
            auto* idv = parsed.as_object().if_contains("id");
            if (!idv || !idv->is_string()) {
                return make_error(req, http::status::bad_request, "missing 'id'");
            }
            std::string id = json::value_to<std::string>(*idv);

            auto target = find_integration(id);
            if (!target) {
                return make_error(req, http::status::not_found, "unknown integration: " + id);
            }

            {
                std::lock_guard<std::mutex> lock(m_active_mutex);
                if (m_active != target) {
                    if (m_active) {
                        m_active->stop();
                    }
                    m_active = target;
                    if (m_running.load()) {
                        m_active->start();
                    }
                }
            }
            persist_state();
            ULog::info(TAG, "Active integration -> " + id);
            return make_json(req, http::status::ok, target->status_json());
        }

        URouter::FResponse UGateway::handle_status(const URouter::FRequest& req) {
            auto a = active();
            if (!a) {
                return make_error(req, http::status::service_unavailable, "no active integration");
            }
            return make_json(req, http::status::ok, a->status_json());
        }

        URouter::FResponse UGateway::handle_get_config(const URouter::FRequest& req) {
            auto a = active();
            if (!a) {
                return make_error(req, http::status::service_unavailable, "no active integration");
            }
            return make_json(req, http::status::ok, a->config_json());
        }

        URouter::FResponse UGateway::handle_put_module_config(const URouter::FRequest& req,
            const std::string& module_id) {
            auto a = active();
            if (!a) {
                return make_error(req, http::status::service_unavailable, "no active integration");
            }
            auto m = a->find_module(module_id);
            if (!m) {
                return make_error(req, http::status::not_found,
                    "active integration has no module '" + module_id + "'");
            }
            boost::system::error_code ec;
            auto parsed = json::parse(req.body(), ec);
            if (ec || !parsed.is_object()) {
                return make_error(req, http::status::bad_request, "invalid json body");
            }
            std::string err;
            if (!m->apply_config(parsed.as_object(), err)) {
                return make_error(req, http::status::bad_request, err);
            }
            persist_state();
            return make_json(req, http::status::ok, a->config_json());
        }

        URouter::FResponse UGateway::handle_module_connect(const URouter::FRequest& req, bool connect) {
            auto a = active();
            if (!a) {
                return make_error(req, http::status::service_unavailable, "no active integration");
            }

            boost::system::error_code ec;
            auto parsed = json::parse(req.body(), ec);
            if (ec || !parsed.is_object()) {
                return make_error(req, http::status::bad_request, "invalid json body");
            }
            auto* idv = parsed.as_object().if_contains("module");
            if (!idv || !idv->is_string()) {
                return make_error(req, http::status::bad_request, "missing 'module'");
            }
            const std::string module_id = json::value_to<std::string>(*idv);

            auto m = a->find_module(module_id);
            if (!m) {
                return make_error(req, http::status::not_found,
                    "active integration has no module '" + module_id + "'");
            }

            if (connect) {
                // start() у поднятого модуля — no-op, поэтому для переподключения
                // сначала гасим: иначе кнопка "Переподключить" ничего не сделает.
                m->stop();
                m->start();
            }
            else {
                m->stop();
            }
            return make_json(req, http::status::ok, m->to_json());
        }

        URouter::FResponse UGateway::handle_get_taxonomy(const URouter::FRequest& req) {
            return make_json(req, http::status::ok, m_taxonomy.to_json());
        }

        URouter::FResponse UGateway::handle_put_taxonomy(const URouter::FRequest& req) {
            boost::system::error_code ec;
            auto parsed = json::parse(req.body(), ec);
            if (ec || !parsed.is_object()) {
                return make_error(req, http::status::bad_request, "invalid json body");
            }
            std::string err;
            if (!m_taxonomy.apply_json(parsed.as_object(), err)) {
                return make_error(req, http::status::bad_request, err);
            }
            persist_state();
            return make_json(req, http::status::ok, m_taxonomy.to_json());
        }

        URouter::FResponse UGateway::handle_ws_connect(const URouter::FRequest& req) {
            auto a = active();
            if (a) {
                a->start();
            }
            return make_json(req, http::status::ok, json::object{ {"status", "connecting"} });
        }

        URouter::FResponse UGateway::handle_ws_disconnect(const URouter::FRequest& req) {
            auto a = active();
            if (a) {
                a->stop();
            }
            return make_json(req, http::status::ok, json::object{ {"status", "disconnected"} });
        }

        URouter::FResponse UGateway::handle_ws_status(const URouter::FRequest& req) {
            auto a = active();
            if (!a) {
                return make_error(req, http::status::service_unavailable, "no active integration");
            }
            auto status = a->status_json();
            json::object o;
            o["connected"] = a->connected();
            // Соединение первого модуля активной конфигурации (совместимость).
            if (auto* mods = status.if_contains("modules"); mods && mods->is_array() && !mods->as_array().empty()) {
                const auto& first = mods->as_array().front().as_object();
                if (auto* c = first.if_contains("connection")) {
                    o["connection"] = *c;
                }
            }
            return make_json(req, http::status::ok, o);
        }

        URouter::FResponse UGateway::handle_versions(const URouter::FRequest& req) {
            auto a = active();
            json::array arr;
            if (a) {
                for (int v : a->protocol_versions()) {
                    arr.push_back(v);
                }
            }
            return make_json(req, http::status::ok, json::object{ {"versions", arr} });
        }

        URouter::FResponse UGateway::handle_devices(const URouter::FRequest& req) {
            return make_json(req, http::status::ok, list_devices());
        }

        URouter::FResponse UGateway::handle_time(const URouter::FRequest& req) {
            return make_json(req, http::status::ok, m_time.snapshot());
        }

        FTimeGpsSnapshot UGateway::get_time_gps() const {
            return m_time.snapshot_struct();
        }

    } // namespace gateway
} // namespace varan
