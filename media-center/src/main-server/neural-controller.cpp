#include "main-server/neural-controller.h"
#include "main-server/helpers.h"

#include <boost/json.hpp>

namespace http = boost::beast::http;
using namespace varan::rest;

UNeuralController::UNeuralController(std::shared_ptr<varan::neural::UNeuralLoader> loader,
    ULogger* logger)
    : m_loader(std::move(loader))
    , m_logger(logger)
{}

// ─── GET /neural/configurations ─────────────────────────────
http::response<http::string_body>
UNeuralController::get_configurations(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /neural/configurations";
    log_request(m_logger, req, tag);

    try {
        boost::json::array arr;
        for (const auto& c : m_loader->list_configurations()) {
            boost::json::object item;
            item["id"] = c.id;
            item["name"] = c.name;
            arr.push_back(std::move(item));
        }
        boost::json::object data;
        data["configurations"] = std::move(arr);
        boost::json::object body;
        body["data"] = std::move(data);

        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── POST /neural/configurations ────────────────────────────
http::response<http::string_body>
UNeuralController::post_configurations(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /neural/configurations";
    log_request(m_logger, req, tag);

    try {
        auto v = boost::json::parse(req.body());
        if (!v.is_object()) {
            return json_error(m_logger, req, http::status::bad_request,
                "body must be object", tag);
        }
        const auto& obj = v.as_object();

        // mode: "merge" (default) | "replace"
        auto mode = varan::neural::UNeuralLoader::EImportMode::MERGE;
        if (auto* m = obj.if_contains("mode"); m && m->is_string()) {
            const std::string s = m->as_string().c_str();
            if (s == "replace") mode = varan::neural::UNeuralLoader::EImportMode::REPLACE_ALL;
            else if (s != "merge") {
                return json_error(m_logger, req, http::status::bad_request,
                    "mode must be 'merge' or 'replace'", tag);
            }
        }

        auto* data = obj.if_contains("data");
        if (!data || !data->is_object()) {
            return json_error(m_logger, req, http::status::bad_request,
                "missing 'data' object", tag);
        }

        if (!m_loader->import_configurations(*data, mode)) {
            return json_error(m_logger, req, http::status::internal_server_error,
                "import failed", tag);
        }
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }
    return json_ok(m_logger, req, boost::json::object{}, tag);
}

// ─── GET /neural/state ──────────────────────────────────────
http::response<http::string_body>
UNeuralController::get_state(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /neural/state";
    log_request(m_logger, req, tag);

    try {
        boost::json::object body;
        body["data"] = m_loader->get_state_raw();
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── POST /neural/state ─────────────────────────────────────
http::response<http::string_body>
UNeuralController::post_state(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /neural/state";
    log_request(m_logger, req, tag);

    std::string config_id, camera_id;
    try {
        auto v = boost::json::parse(req.body());
        if (!v.is_object()) {
            return json_error(m_logger, req, http::status::bad_request,
                "body must be object", tag);
        }
        const auto& obj = v.as_object();
        if (!obj.contains("config_id") || !obj.at("config_id").is_string()) {
            return json_error(m_logger, req, http::status::bad_request,
                "missing config_id", tag);
        }
        if (!obj.contains("camera_id") || !obj.at("camera_id").is_string()) {
            return json_error(m_logger, req, http::status::bad_request,
                "missing camera_id", tag);
        }
        config_id = obj.at("config_id").as_string().c_str();
        camera_id = obj.at("camera_id").as_string().c_str();
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }

    if (!m_loader->write_state(config_id, camera_id)) {
        return json_error(m_logger, req, http::status::bad_request, "invalid state", tag);
    }
    return json_ok(m_logger, req, boost::json::object{}, tag);
}

// ─── GET /neural/status ─────────────────────────────────────
http::response<http::string_body>
UNeuralController::get_status(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /neural/status";
    log_request(m_logger, req, tag);

    try {
        boost::json::object data;
        data["running"] = m_loader->is_running();
        data["config_id"] = m_loader->get_active_config_id();
        data["camera_id"] = m_loader->get_active_camera_id();

        boost::json::object body;
        body["data"] = std::move(data);
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── POST /neural/start ─────────────────────────────────────
http::response<http::string_body>
UNeuralController::post_start(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /neural/start";
    log_request(m_logger, req, tag);

    if (m_loader->is_running()) {
        return json_ok(m_logger, req, boost::json::object{}, tag);
    }
    if (!m_loader->async_run()) {
        return json_error(m_logger, req, http::status::bad_request, "start failed", tag);
    }
    return json_ok(m_logger, req, boost::json::object{}, tag);
}

// ─── POST /neural/restart ───────────────────────────────────
http::response<http::string_body>
UNeuralController::post_restart(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /neural/restart";
    log_request(m_logger, req, tag);

    if (!m_loader->restart()) {
        return json_error(m_logger, req, http::status::bad_request, "restart failed", tag);
    }
    return json_ok(m_logger, req, boost::json::object{}, tag);
}

// ─── POST /neural/stop ──────────────────────────────────────
http::response<http::string_body>
UNeuralController::post_stop(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /neural/stop";
    log_request(m_logger, req, tag);

    try {
        m_loader->stop_async_run();
        return json_ok(m_logger, req, boost::json::object{}, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}