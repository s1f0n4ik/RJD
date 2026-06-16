#include "main-server/linker-controller.h"
#include "main-server/helpers.h"

#include <boost/json.hpp>
#include "utility/json-utils.h"

namespace http = boost::beast::http;
using namespace varan::rest;

ULinkerController::ULinkerController(std::shared_ptr<varan::birdview::ULinker> linker, ULogger* logger)
    : m_linker(linker)
    , m_logger(logger)
{}


// Хелпер для получения querry
static std::optional<std::string>
get_query_param(const std::string& target, const std::string& key) {
    auto qpos = target.find('?');
    if (qpos == std::string::npos) {
        return std::nullopt;
    }

    std::string query = target.substr(qpos + 1);

    std::stringstream ss(query);
    std::string item;
    while (std::getline(ss, item, '&')) {
        auto eq = item.find('=');

        if (eq == std::string::npos) {
            continue;
        }

        auto k = item.substr(0, eq);
        auto v = item.substr(eq + 1);

        if (k == key) {
            return v;
        }
    }

    return std::nullopt;
}

// ─── GET /linker/exports ────────────────────────────────────
http::response<http::string_body>
ULinkerController::get_exports(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /linker/exports";
    log_request(m_logger, req, tag);

    try {
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

        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── GET /linker/state ──────────────────────────────────────
http::response<http::string_body>
ULinkerController::get_state(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /linker/state";
    log_request(m_logger, req, tag);

    try {
        boost::json::object body;
        body["data"] = m_linker->get_state_raw();
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── POST /linker/state ─────────────────────────────────────
http::response<http::string_body>
ULinkerController::post_state(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/state";
    log_request(m_logger, req, tag);

    std::string export_id;
    std::unordered_map<std::string, std::string> bindings;

    try {
        auto v = boost::json::parse(req.body());
        if (!v.is_object()) {
            return json_error(m_logger, req, http::status::bad_request,
                "body must be object", tag);
        }
        const auto& obj = v.as_object();
        if (!obj.contains("export_id") || !obj.at("export_id").is_string()) {
            return json_error(m_logger, req, http::status::bad_request,
                "missing export_id", tag);
        }
        export_id = obj.at("export_id").as_string().c_str();

        if (auto* cams = obj.if_contains("cameras"); cams && cams->is_object()) {
            for (const auto& [k, val] : cams->as_object()) {
                if (val.is_string()) {
                    bindings[std::string(k)] = val.as_string().c_str();
                }
                else {
                    if (m_logger) m_logger->warn(tag + ": camera key '" + std::string(k) +
                        "' has no string value, skipping");
                }
            }
        }
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }

    if (!m_linker->write_state(export_id, bindings)) {
        return json_error(m_logger, req, http::status::bad_request, "invalid state", tag);
    }
    return json_ok(m_logger, req, boost::json::object{}, tag);
}

// ─── GET /linker/status ─────────────────────────────────────
http::response<http::string_body>
ULinkerController::get_status(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /linker/status";
    log_request(m_logger, req, tag);

    try {
        boost::json::object data;
        data["running"] = m_linker->is_running();
        data["export_id"] = m_linker->get_active_export_id();
        data["stream_id"] = m_linker->get_stream_id();

        boost::json::object body;
        body["data"] = std::move(data);
        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── POST /linker/start ─────────────────────────────────────
http::response<http::string_body>
ULinkerController::post_start(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/start";
    log_request(m_logger, req, tag);

    if (m_linker->is_running()) {
        return json_ok(m_logger, req, boost::json::object{}, tag);
    }
    if (!m_linker->async_start()) {
        return json_error(m_logger, req, http::status::bad_request, "start failed", tag);
    }
    return json_ok(m_logger, req, boost::json::object{}, tag);
}

// ─── POST /linker/restart ───────────────────────────────────
http::response<http::string_body>
ULinkerController::post_restart(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/restart";
    log_request(m_logger, req, tag);

    if (!m_linker->restart()) {
        return json_error(m_logger, req, http::status::bad_request, "restart failed", tag);
    }
    return json_ok(m_logger, req, boost::json::object{}, tag);
}

// ─── POST /linker/stop ──────────────────────────────────────
http::response<http::string_body>
ULinkerController::post_stop(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/stop";
    log_request(m_logger, req, tag);

    try {
        m_linker->stop();
        return json_ok(m_logger, req, boost::json::object{}, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── GET /linker/export?id=XXX ─────────────────────────────────────
http::response<http::string_body>
ULinkerController::get_export(const http::request<http::string_body>& req) {
    const std::string tag = "GET /linker/export?id=xxx";
    log_request(m_logger, req, tag);

    try {
        auto export_id = get_query_param(std::string(req.target()), "id");
        if (!export_id) {
            return json_error(m_logger, req, http::status::bad_request, "missing id parameter", tag);
        }

        auto index_path = m_linker->get_configurations_path();
        if (!std::filesystem::exists(index_path)) {
            return json_error(m_logger, req, http::status::not_found, "configuration file not found", tag);
        }

        std::ifstream file(index_path);
        std::stringstream ss;
        ss << file.rdbuf();
        auto parsed = boost::json::parse(ss.str());
        if (!parsed.is_object())
        {
            return json_error(m_logger, req, http::status::internal_server_error, "invalid configuration file", tag);
        }

        auto& root = parsed.as_object();
        auto it = root.find(*export_id);
        if (it == root.end()) {
            return json_error(m_logger, req, http::status::not_found, "export not found", tag);
        }

        boost::json::object body;
        body["data"] = it->value();

        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── POST /linker/exports ───────────────────────────────────
http::response<http::string_body>
ULinkerController::post_exports(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/exports";
    log_request(m_logger, req, tag);

    try {
        auto content_type = std::string(req[http::field::content_type]);
        const auto& body = req.body();

        boost::json::object config_obj;

        // ── Multipart ──
        if (content_type.find("multipart/form-data") != std::string::npos) {
            auto bpos = content_type.find("boundary=");
            if (bpos == std::string::npos) {
                return json_error(m_logger, req, http::status::bad_request, "missing boundary", tag);
            }
            std::string boundary = "--" + content_type.substr(bpos + 9);

            auto images_dir = m_linker->get_images_list_path();
            std::filesystem::create_directories(images_dir);

            // Разбираем части
            size_t pos = 0;
            while ((pos = body.find(boundary, pos)) != std::string::npos) {
                pos += boundary.size();
                if (pos + 2 <= body.size() && body[pos] == '-' && body[pos + 1] == '-')
                    break; // финальный boundary

                auto header_end = body.find("\r\n\r\n", pos);
                if (header_end == std::string::npos) break;
                std::string headers = body.substr(pos, header_end - pos);
                auto data_start = header_end + 4;

                auto next_boundary = body.find(boundary, data_start);
                auto data_end = (next_boundary != std::string::npos)
                    ? next_boundary : body.size();
                // Убрать \r\n перед boundary
                if (data_end >= 2 && body[data_end - 2] == '\r' && body[data_end - 1] == '\n')
                    data_end -= 2;

                std::string part_data = body.substr(data_start, data_end - data_start);

                // Определяем часть по name=
                if (headers.find("name=\"config\"") != std::string::npos) {
                    auto v = boost::json::parse(part_data);
                    if (v.is_object()) config_obj = v.as_object();
                }
                else if (headers.find("name=\"images\"") != std::string::npos) {
                    // Достать filename
                    std::string filename;
                    auto fn_pos = headers.find("filename=\"");
                    if (fn_pos != std::string::npos) {
                        fn_pos += 10;
                        auto fn_end = headers.find("\"", fn_pos);
                        filename = headers.substr(fn_pos, fn_end - fn_pos);
                    }
                    if (!filename.empty()) {
                        auto file_path = images_dir / filename;
                        std::ofstream out(file_path, std::ios::binary);
                        out.write(part_data.data(), part_data.size());
                        out.close();
                        if (m_logger) m_logger->info(tag + ": saved image " + file_path.string());
                    }
                }

                pos = next_boundary != std::string::npos ? next_boundary : body.size();
            }
        }
        // ── Обычный JSON ──
        else {
            auto v = boost::json::parse(body);
            if (!v.is_object()) {
                return json_error(m_logger, req, http::status::bad_request, "body must be object", tag);
            }
            config_obj = v.as_object();
        }

        if (config_obj.empty()) {
            return json_error(m_logger, req, http::status::bad_request, "empty config", tag);
        }

        // Читаем текущий индекс
        auto index_path = m_linker->get_configurations_path();
        boost::json::object index;

        if (std::filesystem::exists(index_path) && !std::filesystem::is_directory(index_path)) {
            std::ifstream f(index_path);
            std::stringstream ss;
            ss << f.rdbuf();
            auto parsed = boost::json::parse(ss.str());
            if (parsed.is_object()) index = parsed.as_object();
        }

        // Мержим
        for (const auto& [key, val] : config_obj) {
            index[key] = val;
        }

        // Записываем
        auto parent = index_path.parent_path();
        if (!parent.empty()) std::filesystem::create_directories(parent);
        std::ostringstream oss;
        pretty_print(oss, index);
        std::ofstream f(index_path);
        f << oss.str();

        if (m_logger) m_logger->info(tag + ": saved " + std::to_string(config_obj.size()) + " config(s)");

        return json_ok(m_logger, req, boost::json::object{}, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── POST /linker/upload-image ──────────────────────────────
http::response<http::string_body>
ULinkerController::post_upload_image(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/upload-image";
    log_request(m_logger, req, tag);

    try {
        auto content_type = std::string(req[http::field::content_type]);

        // Найти boundary
        auto pos = content_type.find("boundary=");
        if (pos == std::string::npos) {
            return json_error(m_logger, req, http::status::bad_request,
                "missing boundary in content-type", tag);
        }
        std::string boundary = "--" + content_type.substr(pos + 9);

        const auto& body = req.body();

        // Найти filename
        auto fn_pos = body.find("filename=\"");
        if (fn_pos == std::string::npos) {
            return json_error(m_logger, req, http::status::bad_request, "missing filename", tag);
        }
        fn_pos += 10;
        auto fn_end = body.find("\"", fn_pos);
        std::string filename = body.substr(fn_pos, fn_end - fn_pos);

        // Санитизация имени файла
        for (auto& c : filename) {
            if (c == '/' || c == '\\' || c == '.') {
                if (c == '.' && (&c - &filename[0]) > 0) continue; // оставить расширение
                c = '_';
            }
        }

        // Найти начало бинарных данных (после \r\n\r\n)
        auto header_end = body.find("\r\n\r\n", fn_pos);
        if (header_end == std::string::npos) {
            return json_error(m_logger, req, http::status::bad_request, "malformed multipart", tag);
        }
        auto data_start = header_end + 4;

        // Найти конец данных (boundary)
        auto data_end = body.find(boundary, data_start);
        if (data_end == std::string::npos) {
            data_end = body.size();
        }
        // Убрать \r\n перед boundary
        if (data_end >= 2 && body[data_end - 2] == '\r' && body[data_end - 1] == '\n') {
            data_end -= 2;
        }

        // Сохранить
        auto images_dir = m_linker->get_images_list_path();
        std::filesystem::create_directories(images_dir);

        auto file_path = images_dir / filename;
        std::ofstream out(file_path, std::ios::binary);
        out.write(body.data() + data_start, data_end - data_start);
        out.close();

        if (m_logger) m_logger->info(tag + ": saved " + file_path.string());

        boost::json::object data;
        data["filename"] = filename;
        boost::json::object result;
        result["data"] = std::move(data);

        return json_ok(m_logger, req, result, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

http::response<http::file_body>
ULinkerController::get_image(const http::request<http::string_body>& req) {
    namespace fs = std::filesystem;
    const std::string tag = "GET /linker/image";

    auto filename = get_query_param(std::string(req.target()), "name" );
    if (!filename) {
        http::response<http::file_body> res{http::status::bad_request, req.version()};
        res.prepare_payload();
        return res;
    }

    auto image_path = m_linker->get_images_list_path() / *filename;
    if (!fs::exists(image_path)) {
        http::response<http::file_body> res{http::status::not_found, req.version()};
        res.prepare_payload();
        return res;
    }

    boost::beast::error_code ec;
    http::file_body::value_type body;
    body.open(image_path.string().c_str(), boost::beast::file_mode::scan, ec);

    if (ec){
        http::response<http::file_body> res{http::status::internal_server_error, req.version()};
        res.prepare_payload();
        return res;
    }

    auto const size = body.size();
    http::response<http::file_body> res{
        std::piecewise_construct,
        std::make_tuple(std::move(body)),
        std::make_tuple(http::status::ok, req.version())
    };

    res.content_length(size);
    res.keep_alive(req.keep_alive());
    auto ext = image_path.extension().string();

    if (ext == ".png")
        res.set(http::field::content_type, "image/png");
    else if (ext == ".jpg" || ext == ".jpeg")
        res.set(http::field::content_type, "image/jpeg");
    else if (ext == ".webp")
        res.set(http::field::content_type, "image/webp");
    else
        res.set(http::field::content_type, "application/octet-stream");

    return res;
}