#include "main-server/linker-controller.h"

#include <boost/json.hpp>
#include <fstream>
#include <sstream>

namespace http = boost::beast::http;

#define LOG_INFO(msg) {if (m_logger) m_logger->info(msg);}
#define LOG_DEBUG(msg) {if (m_logger) m_logger->debug(msg);}
#define LOG_WARN(msg) {if (m_logger) m_logger->warn(msg);}
#define LOG_ERROR(msg) {if (m_logger) m_logger->error(msg);}
#define LOG_RECV(msg) {if (m_logger) m_logger->send(msg);}
#define LOG_SEND(msg) {if (m_logger) m_logger->receive(msg);}

ULinkerController::ULinkerController(std::shared_ptr<varan::birdview::ULinker> linker, ULogger* logger)
    : m_linker(linker) 
    , m_logger(logger)
{}

// ── helpers ──
static http::response<http::string_body> _json_ok(
    unsigned http_version, const boost::json::value& body)
{
    http::response<http::string_body> res{ http::status::ok, http_version };
    res.set(http::field::content_type, "application/json");
    res.set(http::field::access_control_allow_origin, "*");
    res.body() = boost::json::serialize(body);
    res.prepare_payload();
    return res;
}

static http::response<http::string_body> _json_error(
    unsigned http_version, http::status status, const std::string& msg)
{
    http::response<http::string_body> res{ status, http_version };
    res.set(http::field::content_type, "application/json");
    res.set(http::field::access_control_allow_origin, "*");
    boost::json::object body;
    body["error"] = msg;
    res.body() = boost::json::serialize(body);
    res.prepare_payload();
    return res;
}

// ─── GET /linker/exports ────────────────────────────────────
http::response<http::string_body>
ULinkerController::get_exports(const http::request<http::string_body>& req)
{
    LOG_INFO("GET /linker/exports");
    boost::json::array arr;
    for (const auto& e : m_linker->list_exports()) {
        boost::json::object item;
        item["id"] = e.id;
        item["name"] = e.name;
        boost::json::array cams;
        for (const auto& k : e.cameras) cams.emplace_back(k);
        item["cameras"] = std::move(cams);
        arr.push_back(std::move(item));
    }
    boost::json::object data;
    data["exports"] = std::move(arr);
    boost::json::object body;
    body["data"] = std::move(data);
    LOG_SEND("Rest server send json:" + boost::json::serialize(body));
    return _json_ok(req.version(), body);
}

// ─── GET /linker/state ──────────────────────────────────────
http::response<http::string_body>
ULinkerController::get_state(const http::request<http::string_body>& req)
{
    LOG_INFO("GET /linker/state");
    boost::json::object body;
    body["data"] = m_linker->get_state_raw();
    LOG_SEND("Rest server send json:" + boost::json::serialize(body));
    return _json_ok(req.version(), body);
}

// ─── POST /linker/state ─────────────────────────────────────
http::response<http::string_body>
ULinkerController::post_state(const http::request<http::string_body>& req)
{
    LOG_INFO("POST /linker/state");
    std::string export_id;
    std::unordered_map<std::string, std::string> bindings;

    try {
        auto v = boost::json::parse(req.body());
        if (!v.is_object()) {
            return _json_error(req.version(), http::status::bad_request, "body must be object");
        }
        const auto& obj = v.as_object();
        if (!obj.contains("export_id") || !obj.at("export_id").is_string()) {
            return _json_error(req.version(), http::status::bad_request, "missing export_id");
        }
        export_id = obj.at("export_id").as_string().c_str();

        if (auto* cams = obj.if_contains("cameras"); cams && cams->is_object()) {
            for (const auto& [k, val] : cams->as_object()) {
                if (val.is_string()) bindings[std::string(k)] = val.as_string().c_str();
                LOG_WARN("camera key at " + std::string(k) + " has no value!");
                // null / отсутствие → не кладём, в state-файле будет null
            }
        }
    }
    catch (const std::exception& e) {
        return _json_error(req.version(), http::status::bad_request, e.what());
    }

    if (!m_linker->write_state(export_id, bindings)) {
        return _json_error(req.version(), http::status::bad_request, "invalid state");
    }
    return _json_ok(req.version(), boost::json::object{});
}

// ─── GET /linker/status ─────────────────────────────────────
http::response<http::string_body>
ULinkerController::get_status(const http::request<http::string_body>& req)
{
    LOG_INFO("GET /linker/status");
    boost::json::object data;
    data["running"] = m_linker->is_running();
    data["export_id"] = m_linker->get_active_export_id();
    data["stream_id"] = m_linker->get_stream_id();

    boost::json::object body;
    body["data"] = std::move(data);
    LOG_SEND("Rest server send json:" + boost::json::serialize(body));
    return _json_ok(req.version(), body);
}

// ─── POST /linker/start ─────────────────────────────────────
http::response<http::string_body>
ULinkerController::post_start(const http::request<http::string_body>& req)
{
    LOG_INFO("POST /linker/start");
    if (m_linker->is_running()) {
        return _json_ok(req.version(), boost::json::object{});
    }
    if (!m_linker->async_start()) {
        return _json_error(req.version(), http::status::bad_request, "start failed");
    }
    return _json_ok(req.version(), boost::json::object{});
}

// ─── POST /linker/restart ───────────────────────────────────
http::response<http::string_body>
ULinkerController::post_restart(const http::request<http::string_body>& req)
{
    LOG_INFO("POST /linker/restart");
    if (!m_linker->restart()) {
        return _json_error(req.version(), http::status::bad_request, "restart failed");
    }
    return _json_ok(req.version(), boost::json::object{});
}

// ─── POST /linker/stop ──────────────────────────────────────
http::response<http::string_body>
ULinkerController::post_stop(const http::request<http::string_body>& req)
{
    LOG_INFO("POST /linker/stop");
    m_linker->stop();
    return _json_ok(req.version(), boost::json::object{});
}