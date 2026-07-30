#include "main-server/calibration-controller.h"
#include "main-server/helpers.h"

#include <filesystem>
#include <fstream>
#include <set>

#include <boost/json.hpp>

#include "core/paths.h"
#include "calibration/json-calibration.h"

namespace http = boost::beast::http;
using namespace varan::rest;

UCalibrationController::UCalibrationController(ULogger* logger)
    : m_logger(logger)
{}

// Чтение links.json: { "<camera_id>": "<config_key>" }
static boost::json::object read_links(ULogger* logger) {
    boost::json::object links;
    const auto path = varan::paths().surround.calibration_links;

    std::ifstream file(path);
    if (!file.is_open()) {
        return links;
    }

    try {
        std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
        auto parsed = boost::json::parse(content);
        if (parsed.is_object()) {
            links = parsed.as_object();
        }
    }
    catch (const std::exception& e) {
        if (logger) logger->warn("read_links(): broken links.json, treated as empty: " + std::string(e.what()));
    }
    return links;
}

// ─── GET /calibration/links ─────────────────────────────────
http::response<http::string_body>
UCalibrationController::get_links(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /calibration/links";
    log_request(m_logger, req, tag);

    try {
        varan::calibration::UJsonCalibrationConfiguration config(m_logger);
        config.read(varan::paths().surround.calibration_settings);

        boost::json::object data;
        data["links"] = read_links(m_logger);
        data["configs"] = config.get_cameras_info();

        boost::json::object body;
        body["data"] = std::move(data);
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── POST /calibration/links ────────────────────────────────
// Тело: { "links": { "<camera_id>": "<config_key>" } }; пустая строка снимает связь
http::response<http::string_body>
UCalibrationController::post_links(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /calibration/links";
    log_request(m_logger, req, tag);

    try {
        auto parsed = boost::json::parse(req.body());
        if (!parsed.is_object() || !parsed.as_object().if_contains("links")
            || !parsed.as_object().at("links").is_object()) {
            return json_error(m_logger, req, http::status::bad_request, "body must contain object field 'links'", tag);
        }
        const auto& incoming = parsed.as_object().at("links").as_object();

        varan::calibration::UJsonCalibrationConfiguration config(m_logger);
        config.read(varan::paths().surround.calibration_settings);
        std::set<std::string> known_keys;
        for (const auto& item : config.get_cameras_info()) {
            known_keys.insert(std::string(item.as_object().at(varan::calibration::constants::JSON_CONFIG_KEY).as_string()));
        }

        // Запись нормализуется в {config, fps}; строка принимается как легаси
        boost::json::object links;
        for (const auto& [camera_id, value] : incoming) {
            std::string key;
            int fps = 15;

            if (value.is_string()) {
                key = std::string(value.as_string());
            }
            else if (value.is_object()) {
                const auto& link = value.as_object();
                if (auto* c = link.if_contains("config"); c && c->is_string()) {
                    key = std::string(c->as_string());
                }
                if (auto* f = link.if_contains("fps"); f && f->is_number()) {
                    fps = std::clamp(boost::json::value_to<int>(*f), 1, 60);
                }
            }
            else {
                return json_error(m_logger, req, http::status::bad_request,
                    "link for camera <" + std::string(camera_id) + "> must be a string or object", tag);
            }

            if (key.empty()) continue;
            if (!known_keys.count(key)) {
                return json_error(m_logger, req, http::status::bad_request,
                    "unknown calibration config <" + key + "> for camera <" + std::string(camera_id) + ">", tag);
            }

            boost::json::object link;
            link["config"] = key;
            link["fps"] = fps;
            links[camera_id] = std::move(link);
        }

        const auto path = varan::paths().surround.calibration_links;
        const auto tmp = path.string() + ".tmp";
        {
            std::ofstream out(tmp, std::ios::trunc);
            if (!out.is_open()) {
                return json_error(m_logger, req, http::status::internal_server_error, "cannot open links.json for writing", tag);
            }
            out << boost::json::serialize(links);
        }
        std::filesystem::rename(tmp, path);

        boost::json::object data;
        data["links"] = std::move(links);
        boost::json::object body;
        body["data"] = std::move(data);
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}
