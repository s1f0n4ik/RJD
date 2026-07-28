#include "main-server/neural-controller.h"
#include "core/paths.h"
#include "main-server/helpers.h"

#include "neural/constants.h"
#include "neural/camera-layout-json.h"
#include "neural/tracker/tracking-types.h"

#include <boost/json.hpp>

namespace http = boost::beast::http;
using namespace varan::rest;

UNeuralController::UNeuralController(std::shared_ptr<varan::neural::UNeuralLoader> loader,
    ULogger* logger)
    : m_loader(std::move(loader)), m_logger(logger) {}

// Хелпер: загрузить FConfigInfo по config_id
static std::optional<varan::neural::FConfigInfo>
load_config_info(const std::string& config_id) {
    varan::neural::UJsonNeuralConfiguration configurator;
    if (!configurator.read(varan::paths().neural.config))
        return std::nullopt;
    return configurator.load_config(config_id);
}

// Хелпер: достать query-параметр из URL (?key=value)
static std::string extract_query_param(const std::string_view target, const std::string& key) {
    auto pos = target.find('?');
    if (pos == std::string_view::npos) return {};

    std::string_view query = target.substr(pos + 1);
    const std::string prefix = key + "=";

    while (!query.empty()) {
        if (query.substr(0, prefix.size()) == prefix) {
            query.remove_prefix(prefix.size());
            auto amp = query.find('&');
            return std::string(query.substr(0, amp));
        }
        auto amp = query.find('&');
        if (amp == std::string_view::npos) break;
        query.remove_prefix(amp + 1);
    }
    return {};
}

// Сериализация матрицы камер
static boost::json::array serialize_matrix(const varan::neural::FCameraMatrix& m) {
    boost::json::array result;
    for (const auto& row : m) {
        boost::json::array row_arr;
        for (const auto& c : row) row_arr.emplace_back(c);
        result.push_back(std::move(row_arr));
    }
    return result;
}

// Сериализация списка дескрипторов потоков.
// camera_layout — источник правды (нормализованные тайлы); camera_matrix
// отдаём производным (первая камера) для обратной совместимости старого фронта.
static boost::json::array serialize_descs(
    const std::vector<varan::neural::FNeuralCoreConfig>& descs)
{
    boost::json::array arr;
    for (const auto& d : descs) {
        boost::json::object item;
        item["config_id"] = d.config_id;
        item["camera_layout"] = varan::neural::serialize_layout(d.camera_layout);
        item["camera_matrix"] = serialize_matrix(varan::neural::layout_to_matrix(d.camera_layout));
        boost::json::array cores;
        for (int c : d.npu_cores) cores.emplace_back(c);
        item["cores"] = std::move(cores);
        if (d.streaming) {
            boost::json::object st;
            st["enabled"] = true;
            st["name"] = d.streaming->name;
            item["streaming"] = std::move(st);
        }
        else {
            boost::json::object st;
            st["enabled"] = false;
            st["name"] = "";
            item["streaming"] = std::move(st);
        }
        boost::json::array em;
        for (const auto& e : d.event_mask) em.emplace_back(e);
        item["event_mask"] = std::move(em);
        arr.push_back(std::move(item));
    }
    return arr;
}

// ─── GET /neural/configurations ─────────────────────────────
// Без ?id → список {id, name}.
// С ?id=xxx → полный JSON конкретной конфигурации.
http::response<http::string_body>
UNeuralController::get_configurations(const http::request<http::string_body>& req) {
    const std::string tag = "GET /neural/configurations";
    log_request(m_logger, req, tag);

    try {
        const std::string id = extract_query_param(req.target(), "id");

        if (!id.empty()) {
            // Полный конфиг конкретной модели.
            auto cfg = m_loader->get_configuration_full(id);
            if (cfg.is_null()) {
                return json_error(m_logger, req, http::status::not_found,
                    "configuration '" + id + "' not found", tag);
            }
            boost::json::object body;
            body["data"] = std::move(cfg);
            return json_ok(m_logger, req, body, tag);
        }

        // Список всех конфигов (краткий).
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
UNeuralController::post_configurations(const http::request<http::string_body>& req) {
    const std::string tag = "POST /neural/configurations";
    log_request(m_logger, req, tag);

    try {
        auto v = boost::json::parse(req.body());
        if (!v.is_object())
            return json_error(m_logger, req, http::status::bad_request, "body must be object", tag);
        const auto& obj = v.as_object();

        auto mode = varan::neural::UNeuralLoader::EImportMode::MERGE;
        if (auto* m = obj.if_contains("mode"); m && m->is_string()) {
            std::string s = m->as_string().c_str();
            if (s == "replace") mode = varan::neural::UNeuralLoader::EImportMode::REPLACE_ALL;
            else if (s != "merge")
                return json_error(m_logger, req, http::status::bad_request,
                    "mode must be 'merge' or 'replace'", tag);
        }

        auto* data = obj.if_contains("data");
        if (!data || !data->is_object())
            return json_error(m_logger, req, http::status::bad_request, "missing 'data' object", tag);

        if (!m_loader->import_configurations(*data, mode))
            return json_error(m_logger, req, http::status::internal_server_error, "import failed", tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }
    return json_ok(m_logger, req, boost::json::object{}, tag);
}

// ─── GET /neural/state ──────────────────────────────────────
http::response<http::string_body>
UNeuralController::get_state(const http::request<http::string_body>& req) {
    const std::string tag = "GET /neural/state";
    log_request(m_logger, req, tag);
    try {
        boost::json::object body;
        body["data"] = serialize_descs(m_loader->get_active_descriptors());
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── POST /neural/state ─────────────────────────────────────
// {
//     { "config_id": "railway", "camera_matrix": [["cam1"]], "cores": [0, 1] },
//     { "config_id": "lpr",    "camera_matrix": [["cam2"]], "cores": [2] }
// }
http::response<http::string_body>
UNeuralController::post_state(const http::request<http::string_body>& req) {
    const std::string tag = "POST /neural/state";
    log_request(m_logger, req, tag);

    std::vector<varan::neural::FNeuralCoreConfig> active;
    try {
        auto v = boost::json::parse(req.body());

        // Тело теперь — массив напрямую, не объект с ключом "active"
        if (!v.is_array())
            return json_error(m_logger, req, http::status::bad_request,
                "body must be array", tag);

        for (const auto& entry : v.as_array()) {
            if (!entry.is_object())
                return json_error(m_logger, req, http::status::bad_request,
                    "each entry must be object", tag);

            const auto& eo = entry.as_object();
            varan::neural::FNeuralCoreConfig d;

            // config_id — обязательный
            if (!eo.contains("config_id") || !eo.at("config_id").is_string())
                return json_error(m_logger, req, http::status::bad_request,
                    "missing config_id", tag);
            d.config_id = eo.at("config_id").as_string().c_str();

            // Раскладка камер: предпочтительно camera_layout (ячейки/тайлы),
            // иначе фоллбэк на старый camera_matrix (первая камера как single).
            if (auto* cl = eo.if_contains("camera_layout"); cl && cl->is_object()) {
                d.camera_layout = varan::neural::parse_layout(*cl);
            }
            else if (auto* cm = eo.if_contains("camera_matrix"); cm && cm->is_array()) {
                std::string first;
                for (const auto& row_v : cm->as_array()) {
                    if (row_v.is_array() && !row_v.as_array().empty() && row_v.as_array()[0].is_string()) {
                        first = row_v.as_array()[0].as_string().c_str();
                        break;
                    }
                }
                if (!first.empty()) {
                    d.camera_layout.mode = varan::neural::ECameraLayoutMode::SINGLE;
                    d.camera_layout.tiles.push_back(
                        varan::neural::FCameraTile{ first, 0.0f, 0.0f, 1.0f, 1.0f });
                }
            }
            else {
                return json_error(m_logger, req, http::status::bad_request,
                    "missing camera_layout", tag);
            }

            if (varan::neural::layout_cameras(d.camera_layout).empty())
                return json_error(m_logger, req, http::status::bad_request,
                    "'" + d.config_id + "': camera layout has no camera", tag);

            // cores — опциональный массив (пустой допустим для платформ без NPU-ядер)
            if (auto* c = eo.if_contains("cores"); c && c->is_array()) {
                for (const auto& ci : c->as_array())
                    if (ci.is_int64())
                        d.npu_cores.push_back(static_cast<int>(ci.as_int64()));
            }

            // streaming — { enabled, name }
            if (auto* s = eo.if_contains("streaming"); s && s->is_object()) {
                const auto& so = s->as_object();
                bool enabled = false;
                if (auto* e = so.if_contains("enabled"); e && e->is_bool()) enabled = e->as_bool();
                if (enabled) {
                    varan::neural::FStreamingDesc sd;
                    if (auto* n = so.if_contains("name"); n && n->is_string())
                        sd.name = n->as_string().c_str();
                    d.streaming = std::move(sd);
                }
            }

            // event_mask — массив строк (пока просто сохраняется)
            if (auto* em = eo.if_contains("event_mask"); em && em->is_array()) {
                for (const auto& ev : em->as_array())
                    if (ev.is_string()) d.event_mask.emplace_back(ev.as_string().c_str());
            }

            active.push_back(std::move(d));
        }
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }

    // Проверка на уникальность камер между потоками
    {
        std::set<std::string> seen_cameras;
        for (const auto& d : active) {
            for (const auto& cam : varan::neural::layout_cameras(d.camera_layout)) {
                if (!seen_cameras.insert(cam).second) {
                    return json_error(m_logger, req, http::status::bad_request,
                        "camera '" + cam + "' used in multiple streams", tag);
                }
            }
        }
    }

    // Ограничения по платформе
    {
        const auto& plat = m_loader->platform();
        if (plat.mode == "single") {
            if (active.size() > 1)
                return json_error(m_logger, req, http::status::bad_request,
                    plat.label + ": разрешён только один поток", tag);
        }
        else if (plat.mode == "cores") {
            if (static_cast<int>(active.size()) > plat.npu_cores)
                return json_error(m_logger, req, http::status::bad_request,
                    plat.label + ": потоков больше, чем ядер (" + std::to_string(plat.npu_cores) + ")", tag);
            std::set<int> used;
            for (const auto& d : active) {
                for (int c : d.npu_cores) {
                    if (c < 0 || c >= plat.npu_cores)
                        return json_error(m_logger, req, http::status::bad_request,
                            plat.label + ": ядро " + std::to_string(c) + " вне диапазона", tag);
                    if (!used.insert(c).second)
                        return json_error(m_logger, req, http::status::bad_request,
                            plat.label + ": ядро " + std::to_string(c) + " занято несколькими потоками", tag);
                }
            }
        }
        // unlimited (nvidia/unknown) — без ограничений
    }

    if (!m_loader->write_state(active)) {
        return json_error(m_logger, req, http::status::bad_request, "invalid state", tag);
    }

    if (!m_loader->restart()) {
        return json_error(m_logger, req, http::status::bad_request, "state saved but restart failed", tag);
    }

    return json_ok(m_logger, req, boost::json::object{}, tag);
}

// ─── GET /neural/status ─────────────────────────────────────
http::response<http::string_body>
UNeuralController::get_status(const http::request<http::string_body>& req) {
    const std::string tag = "GET /neural/status";
    log_request(m_logger, req, tag);
    try {
        boost::json::array result;
        for (const auto& s : m_loader->get_slots()) {
            boost::json::object item;
            item["config_id"] = s.config_id;
            item["running"] = s.running;
            item["camera_matrix"] = serialize_matrix(s.cameras);
            item["camera_layout"] = varan::neural::serialize_layout(s.camera_layout);
            boost::json::array cores;
            for (int c : s.npu_cores) cores.emplace_back(c);
            item["cores"] = std::move(cores);
            result.push_back(std::move(item));
        }
        boost::json::object body;
        body["data"] = std::move(result);
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── POST start / restart / stop ────────────────────────────
http::response<http::string_body>
UNeuralController::post_start(const http::request<http::string_body>& req) {
    const std::string tag = "POST /neural/start";
    log_request(m_logger, req, tag);
    if (m_loader->is_running()) return json_ok(m_logger, req, boost::json::object{}, tag);
    if (!m_loader->async_run())
        return json_error(m_logger, req, http::status::bad_request, "start failed", tag);
    return json_ok(m_logger, req, boost::json::object{}, tag);
}

http::response<http::string_body>
UNeuralController::post_restart(const http::request<http::string_body>& req) {
    const std::string tag = "POST /neural/restart";
    log_request(m_logger, req, tag);
    if (!m_loader->restart())
        return json_error(m_logger, req, http::status::bad_request, "restart failed", tag);
    return json_ok(m_logger, req, boost::json::object{}, tag);
}

http::response<http::string_body>
UNeuralController::post_stop(const http::request<http::string_body>& req) {
    const std::string tag = "POST /neural/stop";
    log_request(m_logger, req, tag);
    m_loader->stop_async_run();
    return json_ok(m_logger, req, boost::json::object{}, tag);
}

http::response<http::string_body>
UNeuralController::get_classes(const http::request<http::string_body>& req) {
    const std::string tag = "GET /neural/classes";
    log_request(m_logger, req, tag);

    const std::string config_id = extract_query_param(req.target(), "config_id");
    if (config_id.empty())
        return json_error(m_logger, req, http::status::bad_request,
            "config_id query param required", tag);

    try {
        auto cfg = load_config_info(config_id);
        if (!cfg)
            return json_error(m_logger, req, http::status::not_found,
                "configuration '" + config_id + "' not found", tag);

        boost::json::array classes_arr;
        for (const auto& c : cfg->classes) {
            boost::json::object item;
            item["id"] = c.id;
            item["name"] = c.name;
            item["server_id"] = c.server_id;
            item["superclass"] = c.superclass;
            item["color"] = c.color;
            classes_arr.push_back(std::move(item));
        }

        boost::json::object data;
        data["config_id"] = config_id;
        data["classes"] = std::move(classes_arr);

        boost::json::object body;
        body["data"] = std::move(data);
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req,
            http::status::internal_server_error, e.what(), tag);
    }
}

http::response<http::string_body>
UNeuralController::get_superclasses(const http::request<http::string_body>& req) {
    const std::string tag = "GET /neural/superclasses";
    log_request(m_logger, req, tag);

    const std::string config_id = extract_query_param(req.target(), "config_id");
    if (config_id.empty())
        return json_error(m_logger, req, http::status::bad_request,
            "config_id query param required", tag);

    try {
        auto cfg = load_config_info(config_id);
        if (!cfg)
            return json_error(m_logger, req, http::status::not_found,
                "configuration '" + config_id + "' not found", tag);

        boost::json::array superclasses_arr;
        for (const auto& s : cfg->superclasses) {
            boost::json::object item;
            item["key"] = s.key;
            item["name"] = s.name;
            item["color"] = s.color;
            superclasses_arr.push_back(std::move(item));
        }

        boost::json::object data;
        data["config_id"] = config_id;
        data["superclasses"] = std::move(superclasses_arr);

        boost::json::object body;
        body["data"] = std::move(data);
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req,
            http::status::internal_server_error, e.what(), tag);
    }
}

// ─── GET /neural/tracker-types ──────────────────────────────
// Реализованные типы трекеров с человекочитаемыми названиями (RU).
http::response<http::string_body>
UNeuralController::get_tracker_types(const http::request<http::string_body>& req) {
    const std::string tag = "GET /neural/tracker-types";
    log_request(m_logger, req, tag);

    // Единый источник правды по реализованным трекерам. Значение "type"
    // должно совпадать с разбором в UJsonNeuralConfiguration::load_config().
    static const std::vector<std::pair<std::string, std::string>> kTrackerTypes = {
        { "iou", "IoU-трекер" },
    };

    try {
        boost::json::array types_arr;
        for (const auto& [type, name] : kTrackerTypes) {
            boost::json::object item;
            item["type"] = type;
            item["name"] = name;
            types_arr.push_back(std::move(item));
        }
        boost::json::object data;
        data["types"] = std::move(types_arr);
        boost::json::object body;
        body["data"] = std::move(data);
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── GET /neural/system ─────────────────────────────────────
// Тип платформы и лимиты на число потоков.
//   platform: rk3566 | rk3588 | nvidia | unknown
//   mode:     single (1 поток) | cores (по ядрам) | unlimited
//   max_streams: -1 — без ограничений
http::response<http::string_body>
UNeuralController::get_system(const http::request<http::string_body>& req) {
    const std::string tag = "GET /neural/system";
    log_request(m_logger, req, tag);

    try {
        const auto& p = m_loader->platform();
        boost::json::object data;
        data["platform"] = p.platform;
        data["label"] = p.label;
        data["npu_cores"] = p.npu_cores;
        data["max_streams"] = p.max_streams;
        data["mode"] = p.mode;
        boost::json::object body;
        body["data"] = std::move(data);
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── GET /neural/event-types ────────────────────────────────
// Все возможные события трека (идентификаторы). Человекочитаемые
// названия задаёт фронт. Порядок и значения совпадают с ETrackEvent.
http::response<http::string_body>
UNeuralController::get_event_types(const http::request<http::string_body>& req) {
    const std::string tag = "GET /neural/event-types";
    log_request(m_logger, req, tag);

    try {
        boost::json::array events;
        for (auto e : varan::neural::all_track_events()) {
            boost::json::object item;
            item["type"] = varan::neural::track_event_str(e);
            events.push_back(std::move(item));
        }
        boost::json::object data;
        data["events"] = std::move(events);
        boost::json::object body;
        body["data"] = std::move(data);
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

http::response<http::string_body>
UNeuralController::get_models(const http::request<http::string_body>& req) {
    const std::string tag = "GET /neural/models";
    log_request(m_logger, req, tag);

    try {
        namespace fs = std::filesystem;
        const fs::path& model_dir = varan::paths().neural.models;

        boost::json::array models_arr;

        if (fs::exists(model_dir) && fs::is_directory(model_dir)) {
            // Сортируем для стабильного порядка
            std::vector<fs::directory_entry> entries;
            for (const auto& entry : fs::directory_iterator(model_dir)) {
                if (entry.is_regular_file() &&
                    entry.path().extension() == ".rknn")
                {
                    entries.push_back(entry);
                }
            }
            std::sort(entries.begin(), entries.end(),
                [](const auto& a, const auto& b) {
                    return a.path().filename() < b.path().filename();
                });

            for (const auto& entry : entries) {
                boost::json::object item;
                item["filename"] = entry.path().filename().string();
                item["size"] = static_cast<int64_t>(entry.file_size());
                // Путь относительно model_dir для удобства фронтенда
                item["path"] = entry.path().string();
                models_arr.push_back(std::move(item));
            }
        }

        boost::json::object body;
        body["data"] = std::move(models_arr);
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req,
            http::status::internal_server_error, e.what(), tag);
    }
}

http::response<http::string_body>
UNeuralController::post_model(const http::request<http::string_body>& req) {
    const std::string tag = "POST /neural/models";
    log_request(m_logger, req, tag);

    try {
        namespace fs = std::filesystem;

        // Имя файла — из query-параметра
        const std::string filename = extract_query_param(req.target(), "filename");
        if (filename.empty()) {
            return json_error(m_logger, req, http::status::bad_request, "filename query param required", tag);
        }

        // Безопасность: только .rknn, без path traversal
        const fs::path requested(filename);
        if (requested.extension() != ".rknn") {
            return json_error(m_logger, req, http::status::bad_request, "only .rknn files are allowed", tag);
        }
        if (requested.has_parent_path()) {
            return json_error(m_logger, req, http::status::bad_request, "filename must not contain path separators", tag);
        }

        const fs::path target_path = varan::paths().neural.models / requested.filename();

        // Создаём директорию если нет
        fs::create_directories(varan::paths().neural.models);

        // Пишем файл
        const auto& body = req.body();
        if (body.empty()) {
            return json_error(m_logger, req, http::status::bad_request, "empty body", tag);
        }

        std::ofstream out(target_path, std::ios::binary | std::ios::trunc);
        if (!out.is_open()) {
            return json_error(m_logger, req, http::status::internal_server_error,
                "cannot open file for writing: " + target_path.string(), tag);
        }

        out.write(body.data(), static_cast<std::streamsize>(body.size()));
        out.close();

        if (!out) {
            return json_error(m_logger, req, http::status::internal_server_error, "write failed", tag);
        }

        if (m_logger) m_logger->info(tag + ": saved " + target_path.string() +
            " (" + std::to_string(body.size()) + " bytes)");

        boost::json::object data;
        data["filename"] = requested.filename().string();
        data["size"] = static_cast<int64_t>(body.size());
        data["path"] = target_path.string();

        boost::json::object resp_body;
        resp_body["data"] = std::move(data);
        return json_ok(m_logger, req, resp_body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

http::response<http::string_body>
UNeuralController::get_camera_config(const http::request<http::string_body>& req) {
    const std::string tag = "GET /neural/camera";
    log_request(m_logger, req, tag);

    const std::string camera_id = extract_query_param(req.target(), "camera_id");
    if (camera_id.empty())
        return json_error(m_logger, req, http::status::bad_request,
            "camera_id query param required", tag);

    try {
        auto config_id = m_loader->find_camera_config(camera_id);

        boost::json::object data;
        data["camera_id"] = camera_id;

        if (config_id) {
            data["config_id"] = *config_id;
            data["found"] = true;
        }
        else {
            data["config_id"] = nullptr;
            data["found"] = false;
        }

        boost::json::object body;
        body["data"] = std::move(data);
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req,
            http::status::internal_server_error, e.what(), tag);
    }
}

