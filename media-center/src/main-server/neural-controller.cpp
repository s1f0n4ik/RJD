#include "main-server/neural-controller.h"
#include "main-server/helpers.h"

#include "neural/constants.h"

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
    if (!configurator.read(varan::neural::constants::CONFIG_PATH))
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

// Сериализация списка дескрипторов в новый формат
static boost::json::array serialize_descs(
    const std::vector<varan::neural::FNeuralCoreConfig>& descs)
{
    boost::json::array arr;
    for (const auto& d : descs) {
        boost::json::object item;
        item["config_id"] = d.config_id;
        item["camera_matrix"] = serialize_matrix(d.cameras);
        boost::json::array cores;
        for (int c : d.npu_cores) cores.emplace_back(c);
        item["cores"] = std::move(cores);
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

            // camera_matrix — обязательный (раньше было cameras)
            auto* cams = eo.if_contains("camera_matrix");
            if (!cams || !cams->is_array())
                return json_error(m_logger, req, http::status::bad_request,
                    "missing camera_matrix", tag);

            for (const auto& row_v : cams->as_array()) {
                if (!row_v.is_array())
                    return json_error(m_logger, req, http::status::bad_request,
                        "camera_matrix row must be array", tag);
                std::vector<std::string> row;
                for (const auto& cell : row_v.as_array()) {
                    if (!cell.is_string())
                        return json_error(m_logger, req, http::status::bad_request,
                            "camera id must be string", tag);
                    row.emplace_back(cell.as_string().c_str());
                }
                d.cameras.push_back(std::move(row));
            }

            // cores — опциональный (раньше было npu_cores)
            if (auto* c = eo.if_contains("cores"); c && c->is_array()) {
                for (const auto& ci : c->as_array())
                    if (ci.is_int64()) {
                        d.npu_cores.push_back(static_cast<int>(ci.as_int64()));
                    }
            }
            else {
                return json_error(m_logger, req, http::status::bad_request,
                    "cores doesn't exist, or its not json-array", tag);
            }

            active.push_back(std::move(d));
        }
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }

    // Проверка на уникальность камер
    {
        std::set<std::string> seen_cameras;
        for (const auto& d : active) {
            for (const auto& row : d.cameras) {
                for (const auto& cam : row) {
                    if (!seen_cameras.insert(cam).second) {
                        return json_error(m_logger, req, http::status::bad_request,
                            "camera '" + cam + "' used in multiple slots", tag);
                    }
                }
            }
        }
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

http::response<http::string_body>
UNeuralController::get_models(const http::request<http::string_body>& req) {
    const std::string tag = "GET /neural/models";
    log_request(m_logger, req, tag);

    try {
        namespace fs = std::filesystem;
        const fs::path& model_dir = varan::neural::constants::MODEL_PATH;

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

        const fs::path target_path = varan::neural::constants::MODEL_PATH / requested.filename();

        // Создаём директорию если нет
        fs::create_directories(varan::neural::constants::MODEL_PATH);

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

