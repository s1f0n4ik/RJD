#include "gateway/core/gateway.h"
#include "gateway/core/rsm2000-integration.h"
#include "gateway/core/iskra-integration.h"
#include "gateway/grpc/ingress.h"
#include "gateway/utility/devices.h"
#include "gateway/utility/log.h"

#include <filesystem>

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
                m_ws_ioc, m_config.ws, m_config.can, m_config.heartbeat_sec, m_time);
            m_integrations.push_back(rsm);
            m_active = rsm;

            // Очередь записей Modbus — рядом с файлом настроек
            const std::string queue_file = m_config.state_file.empty() ? std::string()
                : (std::filesystem::path(m_config.state_file).parent_path() / "modbus-queue.bin").string();
            m_integrations.push_back(std::make_shared<UIskraIntegration>(
                m_ws_ioc, m_config.modbus, m_time, queue_file, m_config.backend_url));
        }

        void UGateway::restore_state() {
            if (!m_store.enabled()) {
                return;
            }
            const json::object root = m_store.load();
            if (m_store.read_failed()) {
                m_modules_allowed = false;
                m_runtime["state"] = "stopping";
                return;
            }
            if (const auto* value = root.if_contains("config_revision"); value && value->is_string()) m_revision = value->as_string();
            if (const auto* value = root.if_contains("runtime"); value && value->is_object()) {
                m_runtime = value->as_object();
                const auto* state = m_runtime.if_contains("state");
                m_modules_allowed = state && state->is_string() && state->as_string() == "running";
            }

            // Пояс — общешлюзовая настройка, живёт отдельным узлом
            if (const auto* t = root.if_contains("time"); t && t->is_object()) {
                if (const auto* tz = t->as_object().if_contains("tz_offset_min"); tz && tz->is_number()) {
                    m_time.set_tz_offset_min(tz->to_number<int>());
                }
            }

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
                auto selected = find_integration(json::value_to<std::string>(*a));
                if (!a->as_string().empty() && !selected) m_modules_allowed = false;
                std::lock_guard<std::mutex> lock(m_active_mutex);
                m_active = selected;
            }

            ULog::info(TAG, "Settings restored from " + m_config.state_file);
        }

        bool UGateway::persist_state(std::optional<int> tz_offset_min) {
            if (!m_store.enabled()) {
                return false;
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
                    node = ex->as_object();  // сохраняем то, чего нет в памяти
                }
                // Таблица соответствий переехала в мастер обнаружений
                node.erase("taxonomy");
                json::object modules;
                for (const auto& m : it->modules()) {
                    modules[m->id()] = m->config_snapshot();
                }
                node["modules"] = std::move(modules);
                integrations[it->id()] = std::move(node);
            }

            root["active"] = active() ? active()->id() : "";
            root["integrations"] = std::move(integrations);
            root["time"] = json::object{ {"tz_offset_min", tz_offset_min.value_or(m_time.tz_offset_min())} };
            root["runtime"] = m_runtime;
            root["config_revision"] = m_revision;
            return m_store.save(root);
        }

        void UGateway::setup_routes() {
            m_router->add_route(http::verb::get, "/health",
                [this](const auto& r) { return handle_health(r); });

            m_router->add_route(http::verb::get, "/integrations",
                [this](const auto& r) { return handle_list_integrations(r); });
            for (const auto& integration : m_integrations)
                m_router->add_route(http::verb::get, "/integrations/" + integration->id() + "/status",
                    [integration](const auto& request) { return make_json(request, http::status::ok, integration->status_json()); });
            m_router->add_route(http::verb::get, "/runtime",
                [this](const auto& r) { return handle_runtime(r, false); });
            m_router->add_route(http::verb::put, "/runtime",
                [this](const auto& r) { return handle_runtime(r, true); });
            m_router->add_route(http::verb::put, "/config",
                [this](const auto& r) { return handle_apply_config(r); });
            m_router->add_route(http::verb::post, "/config/validate",
                [this](const auto& r) { return handle_apply_config(r, true); });

            m_router->add_route(http::verb::get, "/status",
                [this](const auto& r) { return handle_status(r); });

            m_router->add_route(http::verb::get, "/config",
                [this](const auto& r) { return handle_get_config(r); });

            // Подключение отдельного модуля: тело { "module": "can" }.
            m_router->add_route(http::verb::post, "/modules/connect",
                [this](const auto& r) { return handle_module_connect(r, true); });
            m_router->add_route(http::verb::post, "/modules/disconnect",
                [this](const auto& r) { return handle_module_connect(r, false); });

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

            auto endpoint = boost::asio::ip::tcp::endpoint(
                boost::asio::ip::tcp::v4(), m_config.rest_port);
            auto listener = std::make_shared<UListener>(m_http_ioc, endpoint, m_router);

            if (auto a = active(); a && m_modules_allowed) {
                a->start();
            }

            m_ws_thread = std::thread([this] {
                auto guard = boost::asio::make_work_guard(m_ws_ioc);
                m_ws_ioc.run();
            });

            m_grpc->start();

            listener->run();

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
            std::lock_guard lock(m_runtime_mutex);
            const auto* token = m_runtime.if_contains("transition_id");
            if (!m_modules_allowed || (token && token->is_string() && !token->as_string().empty() && token->as_string() != msg.runtime_id)) {
                FSubmitResult result;
                result.error = "gateway is stopped or message belongs to another profile transition";
                result.status = ESubmitStatus::NotConnected;
                return result;
            }
            auto a = active();
            if (!a) {
                // Отправителю отказывать не за что: статистику писать некуда,
                // но выбранная конфигурация — забота шлюза, а не media-center.
                FSubmitResult result;
                result.ver = msg.ver;
                result.status = ESubmitStatus::Accepted;
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
            if (!m_modules_allowed) return make_error(req, http::status::conflict, "gateway is stopped for profile loading");
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

        URouter::FResponse UGateway::handle_ws_connect(const URouter::FRequest& req) {
            if (!m_modules_allowed) return make_error(req, http::status::conflict, "gateway is stopped for profile loading");
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
