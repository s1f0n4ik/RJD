#include "main-server/config-controller.h"
#include "main-server/helpers.h"

#include <boost/json.hpp>

namespace http = boost::beast::http;
namespace json = boost::json;
using namespace varan::rest;

UConfigController::UConfigController(std::shared_ptr<varan::UMachineConfig> config, ULogger* logger)
    : m_config(std::move(config))
    , m_logger(logger)
{}

static std::string query_value(std::string_view target, const std::string& key) {
    const auto q = target.find('?');
    if (q == std::string_view::npos) return {};
    const std::string query(target.substr(q + 1));
    std::size_t pos = 0;
    while (pos <= query.size()) {
        auto end = query.find('&', pos);
        if (end == std::string::npos) end = query.size();
        const auto pair = query.substr(pos, end - pos);
        if (pair.rfind(key + "=", 0) == 0) return pair.substr(key.size() + 1);
        pos = end + 1;
    }
    return {};
}

// ─── GET /config ────────────────────────────────────────────
http::response<http::string_body>
UConfigController::get_config(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /config";
    log_request(m_logger, req, tag);
    json::object body;
    body["data"] = m_config->applied();
    // Пакет несёт пароли камер: тело ответа в лог не идёт
    return make_response(req.version(), http::status::ok, body);
}

// ─── PUT /config ────────────────────────────────────────────
// Тело: { "revision": "...", "parts": { "<часть>": ... }, "assets": ["<sha256>", ...] }
http::response<http::string_body>
UConfigController::put_config(const http::request<http::string_body>& req)
{
    const std::string tag = "PUT /config";
    try {
        auto parsed = json::parse(req.body());
        if (!parsed.is_object()) {
            return json_error(m_logger, req, http::status::bad_request, "body must be an object", tag);
        }
        const auto& package = parsed.as_object();
        if (m_logger) {
            const auto* revision = package.if_contains("revision");
            m_logger->info(tag + " revision " + (revision && revision->is_string() ? std::string(revision->as_string()) : "?")
                + ", " + std::to_string(req.body().size()) + " bytes");
        }

        auto result = m_config->apply(package);
        if (!result.missing_assets.empty()) {
            json::object body;
            body["error"] = result.error;
            json::array missing;
            for (const auto& sha : result.missing_assets) missing.push_back(json::value(sha));
            body["missing_assets"] = std::move(missing);
            return make_response(req.version(), http::status::conflict, body);
        }
        if (!result.ok) {
            return json_error(m_logger, req, http::status::unprocessable_entity, result.error, tag);
        }
        json::object data;
        data["revision"] = m_config->revision();
        json::object body;
        body["data"] = std::move(data);
        return make_response(req.version(), http::status::ok, body);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }
}

// ─── PUT /config/assets?sha256=<hex> ────────────────────────
http::response<http::string_body>
UConfigController::put_asset(const http::request<http::string_body>& req)
{
    const std::string tag = "PUT /config/assets";
    const auto sha = query_value(req.target(), "sha256");
    if (auto error = m_config->put_asset(sha, req.body()); !error.empty()) {
        return json_error(m_logger, req, http::status::bad_request, error, tag);
    }
    json::object data;
    data["sha256"] = sha;
    json::object body;
    body["data"] = std::move(data);
    return make_response(req.version(), http::status::ok, body);
}
