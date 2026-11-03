#include "gateway/core/gateway.h"

#include <future>
#include <stdexcept>

namespace varan::gateway {
    namespace {
        namespace http = boost::beast::http;
        namespace json = boost::json;

        std::string text(const json::object& body, const char* key) {
            const auto* value = body.if_contains(key);
            return value && value->is_string() ? std::string(value->as_string()) : std::string();
        }

        URouter::FResponse response(const URouter::FRequest& request, http::status status, const json::object& body) {
            URouter::FResponse result{status, request.version()};
            result.set(http::field::content_type, "application/json");
            result.body() = json::serialize(body);
            result.prepare_payload();
            return result;
        }
    }

    URouter::FResponse UGateway::handle_runtime(const URouter::FRequest& request, bool write) {
        std::lock_guard lock(m_runtime_mutex);
        try {
            if (write) {
                const auto body = json::parse(request.body()).as_object();
                const auto token = text(body, "transition_id");
                const auto action = text(body, "action");
                if (token.empty() || (action != "stop" && action != "start")) throw std::runtime_error("invalid runtime command");
                if (action == "stop") {
                    if (text(m_runtime, "transition_id") != token || text(m_runtime, "state") != "stopped") {
                        const auto previous = text(m_runtime, "transition_id");
                        if (previous != token && text(body, "previous_transition_id") != previous)
                            throw std::runtime_error("runtime stop belongs to an obsolete transition");
                        if (previous == token && text(m_runtime, "state") == "running")
                            throw std::runtime_error("profile transition has already completed");
                        m_modules_allowed = false;
                        m_runtime = {{"transition_id", token}, {"state", "stopping"}};
                        persist_state();
                        for (const auto& integration : m_integrations) integration->stop();
                        auto complete = std::make_shared<std::promise<void>>();
                        auto future = complete->get_future();
                        boost::asio::post(m_ws_ioc, [complete] { complete->set_value(); });
                        if (future.wait_for(std::chrono::seconds(15)) != std::future_status::ready)
                            throw std::runtime_error("gateway transports have not stopped");
                        for (const auto& integration : m_integrations)
                            for (const auto& module : integration->modules()) {
                                if (!module->wait_stopped()) throw std::runtime_error(module->id() + " has not stopped");
                                module->reset_runtime();
                            }
                        m_runtime["state"] = "stopped";
                        if (!persist_state()) {
                            m_runtime["state"] = "stopping";
                            throw std::runtime_error("cannot persist stopped state");
                        }
                    }
                    else if (!persist_state()) throw std::runtime_error("cannot persist stopped state");
                }
                else {
                    if (text(m_runtime, "transition_id") != token || text(body, "revision") != m_revision || m_revision.empty())
                        throw std::runtime_error("runtime start does not match applied configuration");
                    if (text(m_runtime, "state") != "running") {
                        if (text(m_runtime, "state") != "stopped" && text(m_runtime, "state") != "starting")
                            throw std::runtime_error("gateway has not stopped");
                        m_runtime["state"] = "starting";
                        if (!persist_state()) throw std::runtime_error("cannot persist starting state");
                        if (auto selected = active()) selected->start();
                        m_runtime["state"] = "running";
                        if (!persist_state()) throw std::runtime_error("cannot persist running state");
                        m_modules_allowed = true;
                    }
                    else {
                        if (!persist_state()) throw std::runtime_error("cannot persist running state");
                        m_modules_allowed = true;
                    }
                }
            }
            auto status = m_runtime;
            status["revision"] = m_revision;
            return response(request, http::status::ok, {{"data", status}});
        }
        catch (const std::exception& error) {
            return response(request, http::status::conflict, {{"error", error.what()}});
        }
    }

    URouter::FResponse UGateway::handle_apply_config(const URouter::FRequest& request, bool validate_only) {
        std::lock_guard lock(m_runtime_mutex);
        try {
            const auto body = json::parse(request.body()).as_object();
            const auto revision = text(body, "revision");
            const auto selected_id = text(body, "active");
            int offset = 180;
            if (const auto* time = body.if_contains("time")) {
                const auto& value = time->as_object().at("tz_offset_min");
                if ((!value.is_int64() && !value.is_uint64()) || value.to_number<std::int64_t>() < -720 || value.to_number<std::int64_t>() > 840)
                    throw std::runtime_error("tz_offset_min must be an integer in -720..840");
                offset = value.to_number<int>();
            }
            if (revision.empty()) throw std::runtime_error("missing configuration revision");
            const auto token = text(m_runtime, "transition_id");
            if (!validate_only && text(body, "transition_id") != token) throw std::runtime_error("configuration belongs to another transition");
            if (!validate_only && !m_modules_allowed && text(m_runtime, "state") != "stopped") throw std::runtime_error("gateway has not stopped");
            auto selected = selected_id.empty() ? nullptr : find_integration(selected_id);
            if (!selected_id.empty() && !selected) throw std::runtime_error("unknown active integration");
            const auto current = active();
            if (!validate_only && m_modules_allowed && ((current ? current->id() : "") != selected_id))
                throw std::runtime_error("integration changes require a profile transition");
            const auto& sources = body.at("integrations").as_object();
            for (const auto& entry : sources) if (!find_integration(std::string(entry.key()))) throw std::runtime_error("unknown integration");
            std::vector<std::pair<std::shared_ptr<IModule>, json::object>> prepared;
            json::object normalized_sources;
            for (const auto& integration : m_integrations) {
                json::object modules;
                if (const auto* source = sources.if_contains(integration->id())) modules = source->as_object().at("modules").as_object();
                for (const auto& entry : modules)
                    if (!integration->find_module(std::string(entry.key()))) throw std::runtime_error("unknown integration module");
                for (const auto& module : integration->modules()) {
                    json::object normalized;
                    std::string error;
                    const auto* source = modules.if_contains(module->id());
                    if (!module->prepare_config(source ? source->as_object() : json::object{}, normalized, error))
                        throw std::runtime_error(module->id() + ": " + error);
                    modules[module->id()] = normalized;
                    prepared.emplace_back(module, std::move(normalized));
                }
                normalized_sources[integration->id()] = json::object{{"modules", modules}};
            }
            if (validate_only) return response(request, http::status::ok, {{"integrations", normalized_sources}, {"time", json::object{{"tz_offset_min", offset}}}});
            for (const auto& [module, config] : prepared) {
                if (module->config_snapshot() == config) continue;
                std::string error;
                if (!module->apply_config(config, error)) throw std::runtime_error(module->id() + ": " + error);
            }
            {
                std::lock_guard active_lock(m_active_mutex);
                m_active = selected;
            }
            const auto previous_revision = m_revision;
            m_revision = revision;
            if (!persist_state(offset)) {
                m_revision = previous_revision;
                throw std::runtime_error("cannot persist applied gateway configuration");
            }
            m_time.set_tz_offset_min(offset);
            return response(request, http::status::ok, {{"data", json::object{{"revision", m_revision}}}});
        }
        catch (const std::exception& error) {
            return response(request, http::status::unprocessable_entity, {{"error", error.what()}});
        }
    }
}
