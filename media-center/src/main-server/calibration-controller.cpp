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
