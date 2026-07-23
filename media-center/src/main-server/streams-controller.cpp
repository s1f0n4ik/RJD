#include "main-server/streams-controller.h"
#include "main-server/helpers.h"

#include <boost/json.hpp>
#include <algorithm>
#include <map>
#include <vector>

namespace http = boost::beast::http;
using namespace varan::rest;

UStreamsController::UStreamsController(
    std::shared_ptr<varan::birdview::ULinker> linker,
    std::shared_ptr<varan::neural::UNeuralLoader> loader,
    ULogger* logger
)
    : m_linker(std::move(linker))
    , m_loader(std::move(loader))
    , m_logger(logger)
{}

// Источник разбором, а не готовой строкой: текст собирает клиент
static void put_source(
    boost::json::object& item,
    const std::string& producer,
    const std::string& source_id,
    const std::string& source_name,
    boost::json::array cameras)
{
    item["producer"] = producer;
    item["source_id"] = source_id;
    item["source_name"] = source_name;
    item["cameras"] = std::move(cameras);
}

std::optional<boost::json::object> UStreamsController::collect_birdview() {
    if (!m_linker) return std::nullopt;

    const std::string export_id = m_linker->get_active_export_id();
    if (export_id.empty()) return std::nullopt;

    const auto params = m_linker->get_stream_params();
    const auto [width, height] = m_linker->get_output_size();

    // Имя конфигурации лежит в индексе экспортов, в состоянии его нет
    std::string source_name;
    try {
        for (const auto& info : m_linker->list_exports()) {
            if (info.id == export_id) {
                source_name = info.name;
                break;
            }
        }
    }
    catch (const std::exception& e) {
        if (m_logger) m_logger->warn("collect_birdview(): " + std::string(e.what()));
    }

    // В состоянии камеры лежат как «место -> камера», пустые места пропускаем
    boost::json::array cameras;
    try {
        auto root = m_linker->get_state_raw();
        if (auto* configs = root.if_contains("configs"); configs && configs->is_object()) {
            if (auto* entry = configs->as_object().if_contains(export_id); entry && entry->is_object()) {
                if (auto* cams = entry->as_object().if_contains("cameras"); cams && cams->is_object()) {
                    for (const auto& [place, camera] : cams->as_object()) {
                        if (!camera.is_string()) continue;
                        const std::string id = camera.as_string().c_str();
                        if (!id.empty()) cameras.emplace_back(id);
                    }
                }
            }
        }
    }
    catch (const std::exception& e) {
        if (m_logger) m_logger->warn("collect_birdview(): " + std::string(e.what()));
    }

    boost::json::object item;
    item["id"] = params.stream_id;
    item["name"] = params.stream_name;
    item["width"] = static_cast<int64_t>(width);
    item["height"] = static_cast<int64_t>(height);
    item["running"] = m_linker->is_running();
    put_source(item, "birdview", export_id, source_name, std::move(cameras));

    return item;
}

boost::json::array UStreamsController::collect_neural() {
    boost::json::array result;
    if (!m_loader) return result;

    // У слота есть только id конфигурации, имя берётся из списка конфигураций
    std::map<std::string, std::string> names;
    try {
        for (const auto& cfg : m_loader->list_configurations()) {
            names[cfg.id] = cfg.name;
        }
    }
    catch (const std::exception& e) {
        if (m_logger) m_logger->warn("collect_neural(): " + std::string(e.what()));
    }

    for (const auto& slot : m_loader->get_slots()) {
        // Слот без трансляции потоком не является
        if (slot.stream_id.empty()) continue;

        // Одна камера может стоять в нескольких клетках матрицы, повторы убираем
        boost::json::array cameras;
        std::vector<std::string> seen;
        for (const auto& row : slot.cameras) {
            for (const auto& camera : row) {
                if (camera.empty()) continue;
                if (std::find(seen.begin(), seen.end(), camera) != seen.end()) continue;
                seen.push_back(camera);
                cameras.emplace_back(camera);
            }
        }

        const auto it = names.find(slot.config_id);

        boost::json::object item;
        item["id"] = slot.stream_id;
        item["name"] = slot.stream_name;
        item["width"] = static_cast<int64_t>(slot.stream_width);
        item["height"] = static_cast<int64_t>(slot.stream_height);
        item["running"] = slot.running;
        put_source(item, "neural", slot.config_id,
            it != names.end() ? it->second : std::string{}, std::move(cameras));

        result.push_back(std::move(item));
    }

    return result;
}

boost::json::array UStreamsController::collect() {
    boost::json::array data;

    if (auto bird = collect_birdview()) {
        data.push_back(std::move(*bird));
    }

    for (auto& item : collect_neural()) {
        data.push_back(std::move(item));
    }

    return data;
}

// ─── GET /streams ───────────────────────────────────────────
http::response<http::string_body>
UStreamsController::get_streams(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /streams";
    log_request(m_logger, req, tag);

    try {
        boost::json::object body;
        body["data"] = collect();
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}
