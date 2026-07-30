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


/*
    Раскодирование percent-encoding.

    Браузер обязан кодировать всё небезопасное, а имена файлов у нас бывают
    кириллическими — «РЖД.png» приезжает как %D0%A0%D0%96%D0%94.png. Без
    раскодирования сервер ищет файл с таким именем буквально и не находит.
*/
static std::string url_decode(const std::string& value) {
    std::string out;
    out.reserve(value.size());

    for (size_t i = 0; i < value.size(); ++i) {
        if (value[i] == '+') {
            out.push_back(' ');
            continue;
        }
        if (value[i] != '%' || i + 2 >= value.size()) {
            out.push_back(value[i]);
            continue;
        }

        const auto hex = value.substr(i + 1, 2);
        if (!std::isxdigit(static_cast<unsigned char>(hex[0]))
            || !std::isxdigit(static_cast<unsigned char>(hex[1])))
        {
            // Одинокий процент — оставляем как есть, ломать строку не за что
            out.push_back(value[i]);
            continue;
        }

        out.push_back(static_cast<char>(std::stoi(hex, nullptr, 16)));
        i += 2;
    }

    return out;
}

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
            return url_decode(v);
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
            item["valid"] = e.valid;
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
    varan::birdview::ULinker::FStreamParams params;

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

        // Параметры запуска необязательны: без них остаются прежние
        if (auto* f = obj.if_contains("fps"); f && f->is_int64()) {
            const auto fps = f->as_int64();
            if (fps < 1 || fps > 60) {
                return json_error(m_logger, req, http::status::bad_request,
                    "fps must be within 1..60", tag);
            }
            params.fps = static_cast<uint32_t>(fps);
        }
        if (auto* s = obj.if_contains("stream_id"); s && s->is_string()) {
            params.stream_id = s->as_string().c_str();
        }
        if (auto* s = obj.if_contains("stream_name"); s && s->is_string()) {
            params.stream_name = s->as_string().c_str();
        }
        if (auto* r = obj.if_contains("rotation"); r && r->is_int64()) {
            const int degrees = static_cast<int>(r->as_int64());
            if (!varan::birdview::ULinker::is_valid_rotation(degrees)) {
                return json_error(m_logger, req, http::status::bad_request,
                    "rotation must be one of 0, 90, 180, 270", tag);
            }
            params.rotation = degrees;
        }
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }

    if (!m_linker->write_state(export_id, bindings, params)) {
        return json_error(m_logger, req, http::status::bad_request, "invalid state", tag);
    }
    return json_ok(m_logger, req, boost::json::object{}, tag);
}

// ─── POST /linker/rotation ──────────────────────────────────
/*
    Поворот вывода. Отдельной ручкой, потому что менять его нужно не только
    с экрана линкера: это свойство картинки, а не настроек одной страницы.
*/
http::response<http::string_body>
ULinkerController::post_rotation(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/rotation";
    log_request(m_logger, req, tag);

    int rotation = -1;
    std::string export_id;

    try {
        auto v = boost::json::parse(req.body());
        if (!v.is_object()) {
            return json_error(m_logger, req, http::status::bad_request, "body must be object", tag);
        }
        const auto& obj = v.as_object();

        if (auto* r = obj.if_contains("rotation"); r && r->is_int64()) {
            rotation = static_cast<int>(r->as_int64());
        }
        else {
            return json_error(m_logger, req, http::status::bad_request, "missing rotation", tag);
        }

        // Без export_id правим активную конфигурацию
        if (auto* e = obj.if_contains("export_id"); e && e->is_string()) {
            export_id = e->as_string().c_str();
        }
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }

    std::string error;
    if (!m_linker->set_rotation(export_id, rotation, error)) {
        return json_error(m_logger, req, http::status::bad_request, error, tag);
    }

    boost::json::object data;
    data["rotation"] = rotation;
    data["export_id"] = export_id.empty() ? m_linker->get_active_export_id() : export_id;

    boost::json::object body;
    body["data"] = std::move(data);
    return json_ok(m_logger, req, body, tag);
}

// ─── POST /linker/view-mode ─────────────────────────────────
http::response<http::string_body>
ULinkerController::post_view_mode(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/view-mode";
    log_request(m_logger, req, tag);

    std::string mode;
    std::string export_id;

    try {
        auto v = boost::json::parse(req.body());
        if (!v.is_object()) {
            return json_error(m_logger, req, http::status::bad_request, "body must be object", tag);
        }
        const auto& obj = v.as_object();

        if (auto* m = obj.if_contains("view_mode"); m && m->is_string()) {
            mode = m->as_string().c_str();
        }
        else {
            return json_error(m_logger, req, http::status::bad_request, "missing view_mode", tag);
        }

        // Без export_id правим активную конфигурацию
        if (auto* e = obj.if_contains("export_id"); e && e->is_string()) {
            export_id = e->as_string().c_str();
        }
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }

    std::string error;
    if (!m_linker->set_view_mode(export_id, mode, error)) {
        return json_error(m_logger, req, http::status::bad_request, error, tag);
    }

    boost::json::object data;
    data["view_mode"] = mode;
    data["export_id"] = export_id.empty() ? m_linker->get_active_export_id() : export_id;

    boost::json::object body;
    body["data"] = std::move(data);
    return json_ok(m_logger, req, body, tag);
}

// ─── POST /linker/surround-camera ───────────────────────────
http::response<http::string_body>
ULinkerController::post_surround_camera(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/surround-camera";
    log_request(m_logger, req, tag);

    std::string export_id, place_key;
    boost::json::object payload;

    try {
        auto v = boost::json::parse(req.body());
        if (!v.is_object()) {
            return json_error(m_logger, req, http::status::bad_request, "body must be object", tag);
        }
        payload = v.as_object();

        if (auto* p = payload.if_contains("place_key"); p && p->is_string()) {
            place_key = p->as_string().c_str();
        }
        else {
            return json_error(m_logger, req, http::status::bad_request, "missing place_key", tag);
        }
        // Без export_id правим активную конфигурацию
        if (auto* e = payload.if_contains("export_id"); e && e->is_string()) {
            export_id = e->as_string().c_str();
        }
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }

    std::string error;
    if (!m_linker->set_surround_camera(export_id, place_key, payload, error)) {
        return json_error(m_logger, req, http::status::bad_request, error, tag);
    }

    boost::json::object data;
    data["place_key"] = place_key;
    data["export_id"] = export_id.empty() ? m_linker->get_active_export_id() : export_id;

    boost::json::object body;
    body["data"] = std::move(data);
    return json_ok(m_logger, req, body, tag);
}

// ─── POST /linker/surround ──────────────────────────────────
http::response<http::string_body>
ULinkerController::post_surround(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/surround";
    log_request(m_logger, req, tag);

    std::string export_id;
    boost::json::object payload;

    try {
        auto v = boost::json::parse(req.body());
        if (!v.is_object()) {
            return json_error(m_logger, req, http::status::bad_request, "body must be object", tag);
        }
        payload = v.as_object();

        // Без export_id правим активную конфигурацию
        if (auto* e = payload.if_contains("export_id"); e && e->is_string()) {
            export_id = e->as_string().c_str();
        }
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }

    std::string error;
    if (!m_linker->set_surround(export_id, payload, error)) {
        return json_error(m_logger, req, http::status::bad_request, error, tag);
    }

    boost::json::object data;
    data["export_id"] = export_id.empty() ? m_linker->get_active_export_id() : export_id;

    boost::json::object body;
    body["data"] = std::move(data);
    return json_ok(m_logger, req, body, tag);
}

// ─── GET /linker/surround?id=XXX ────────────────────────────
http::response<http::string_body>
ULinkerController::get_surround(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /linker/surround";
    log_request(m_logger, req, tag);

    // Без id отдаётся активная конфигурация
    std::string export_id;
    if (auto id = get_query_param(std::string(req.target()), "id"); id && !id->empty()) {
        export_id = *id;
    }

    std::string error;
    boost::json::object data;
    if (!m_linker->get_surround(export_id, data, error)) {
        return json_error(m_logger, req, http::status::not_found, error, tag);
    }

    boost::json::object body;
    body["data"] = std::move(data);
    return json_ok(m_logger, req, body, tag);
}

// ─── POST /linker/top ───────────────────────────────────────
http::response<http::string_body>
ULinkerController::post_top(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/top";
    log_request(m_logger, req, tag);

    std::string export_id;
    boost::json::object payload;

    try {
        auto v = boost::json::parse(req.body());
        if (!v.is_object()) {
            return json_error(m_logger, req, http::status::bad_request, "body must be object", tag);
        }
        payload = v.as_object();

        // Без export_id правим активную конфигурацию
        if (auto* e = payload.if_contains("export_id"); e && e->is_string()) {
            export_id = e->as_string().c_str();
        }
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }

    std::string error;
    if (!m_linker->set_top(export_id, payload, error)) {
        return json_error(m_logger, req, http::status::bad_request, error, tag);
    }

    boost::json::object data;
    data["export_id"] = export_id.empty() ? m_linker->get_active_export_id() : export_id;

    boost::json::object body;
    body["data"] = std::move(data);
    return json_ok(m_logger, req, body, tag);
}

// ─── GET /linker/top?id=XXX ─────────────────────────────────
http::response<http::string_body>
ULinkerController::get_top(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /linker/top";
    log_request(m_logger, req, tag);

    // Без id отдаётся активная конфигурация
    std::string export_id;
    if (auto id = get_query_param(std::string(req.target()), "id"); id && !id->empty()) {
        export_id = *id;
    }

    std::string error;
    boost::json::object data;
    if (!m_linker->get_top(export_id, data, error)) {
        return json_error(m_logger, req, http::status::not_found, error, tag);
    }

    boost::json::object body;
    body["data"] = std::move(data);
    return json_ok(m_logger, req, body, tag);
}

// ─── POST /linker/top-version ───────────────────────────────
http::response<http::string_body>
ULinkerController::post_top_version(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/top-version";
    log_request(m_logger, req, tag);

    std::string export_id, version;

    try {
        auto v = boost::json::parse(req.body());
        if (!v.is_object()) {
            return json_error(m_logger, req, http::status::bad_request, "body must be object", tag);
        }
        const auto& obj = v.as_object();

        if (auto* p = obj.if_contains("version"); p && p->is_string()) {
            version = p->as_string().c_str();
        }
        else {
            return json_error(m_logger, req, http::status::bad_request, "missing version", tag);
        }
        if (auto* e = obj.if_contains("export_id"); e && e->is_string()) {
            export_id = e->as_string().c_str();
        }
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }

    std::string error;
    if (!m_linker->set_top_version(export_id, version, error)) {
        return json_error(m_logger, req, http::status::bad_request, error, tag);
    }

    boost::json::object data;
    data["version"] = version;
    data["export_id"] = export_id.empty() ? m_linker->get_active_export_id() : export_id;

    boost::json::object body;
    body["data"] = std::move(data);
    return json_ok(m_logger, req, body, tag);
}

// ─── POST /linker/recalc ────────────────────────────────────
http::response<http::string_body>
ULinkerController::post_recalc(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/recalc";
    log_request(m_logger, req, tag);

    std::string export_id;

    try {
        // Тело необязательно: без export_id пересчитывается активная
        if (!req.body().empty()) {
            auto v = boost::json::parse(req.body());
            if (v.is_object()) {
                if (auto* e = v.as_object().if_contains("export_id"); e && e->is_string()) {
                    export_id = e->as_string().c_str();
                }
            }
        }
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::bad_request, e.what(), tag);
    }

    // Синхронный пересчёт на несколько секунд: фронт держит спиннер
    std::string error;
    if (!m_linker->recalc_top(export_id, error)) {
        return json_error(m_logger, req, http::status::bad_request, error, tag);
    }

    boost::json::object data;
    data["export_id"] = export_id.empty() ? m_linker->get_active_export_id() : export_id;

    boost::json::object body;
    body["data"] = std::move(data);
    return json_ok(m_logger, req, body, tag);
}

// ─── DELETE /linker/export?id=XXX ───────────────────────────
http::response<http::string_body>
ULinkerController::delete_export(const http::request<http::string_body>& req)
{
    const std::string tag = "DELETE /linker/export";
    log_request(m_logger, req, tag);

    auto id = get_query_param(std::string(req.target()), "id");
    if (!id || id->empty()) {
        return json_error(m_logger, req, http::status::bad_request, "missing id", tag);
    }

    std::string error;
    if (!m_linker->delete_export(*id, error)) {
        // Запущенную конфигурацию удалять нельзя — это не ошибка сервера,
        // а конфликт состояния, и клиент должен его показать как есть
        const auto status = error.find("is running") != std::string::npos
            ? http::status::conflict
            : http::status::bad_request;
        return json_error(m_logger, req, status, error, tag);
    }

    return json_ok(m_logger, req, boost::json::object{}, tag);
}

/*
    Пресеты конфигуратора. Лежат в своём файле и к экспортам отношения не имеют:
    конфигуратор рисует поле, а страница сборки уже по нему считает карты.
*/
static std::optional<boost::json::object> read_presets_root(
    const std::filesystem::path& path,
    std::string& error)
{
    if (!std::filesystem::exists(path)) {
        error = "presets file not found at " + path.string();
        return std::nullopt;
    }
    std::ifstream f(path);
    if (!f.is_open()) {
        error = "cannot open " + path.string();
        return std::nullopt;
    }
    std::stringstream ss; ss << f.rdbuf();

    try {
        auto v = boost::json::parse(ss.str());
        if (!v.is_object()) {
            error = "presets root is not an object";
            return std::nullopt;
        }
        return v.as_object();
    }
    catch (const std::exception& e) {
        error = e.what();
        return std::nullopt;
    }
}

// ─── GET /linker/presets ────────────────────────────────────
http::response<http::string_body>
ULinkerController::get_presets(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /linker/presets";
    log_request(m_logger, req, tag);

    std::string error;
    auto root = read_presets_root(m_linker->get_configurations_path(), error);
    if (!root) {
        return json_error(m_logger, req, http::status::not_found, error, tag);
    }

    boost::json::array arr;
    for (const auto& [key, value] : *root) {
        if (!value.is_object()) continue;
        const auto& obj = value.as_object();

        boost::json::object item;
        item["key"] = key;
        if (auto* n = obj.if_contains("name"); n && n->is_string()) item["name"] = *n;
        if (auto* c = obj.if_contains("canvas"); c && c->is_object()) item["canvas"] = *c;
        if (auto* cams = obj.if_contains("cameras"); cams && cams->is_object()) {
            item["cameras"] = static_cast<int64_t>(cams->as_object().size());
        }
        arr.push_back(std::move(item));
    }

    boost::json::object data;
    data["presets"] = std::move(arr);
    boost::json::object body;
    body["data"] = std::move(data);
    return json_ok(m_logger, req, body, tag);
}

// ─── GET /linker/preset?key=XXX ─────────────────────────────
http::response<http::string_body>
ULinkerController::get_preset(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /linker/preset?key=xxx";
    log_request(m_logger, req, tag);

    auto key = get_query_param(std::string(req.target()), "key");
    if (!key || key->empty()) {
        return json_error(m_logger, req, http::status::bad_request, "missing key parameter", tag);
    }

    std::string error;
    auto root = read_presets_root(m_linker->get_configurations_path(), error);
    if (!root) {
        return json_error(m_logger, req, http::status::not_found, error, tag);
    }

    auto it = root->find(*key);
    if (it == root->end()) {
        return json_error(m_logger, req, http::status::not_found, "preset <" + *key + "> not found", tag);
    }

    boost::json::object body;
    body["data"] = it->value();
    return json_ok(m_logger, req, body, tag);
}

// ─── DELETE /linker/preset?key=XXX ──────────────────────────
http::response<http::string_body>
ULinkerController::delete_preset(const http::request<http::string_body>& req)
{
    const std::string tag = "DELETE /linker/preset?key=xxx";
    log_request(m_logger, req, tag);

    auto key = get_query_param(std::string(req.target()), "key");
    if (!key || key->empty()) {
        return json_error(m_logger, req, http::status::bad_request, "missing key parameter", tag);
    }

    const auto path = m_linker->get_configurations_path();

    std::string error;
    auto root = read_presets_root(path, error);
    if (!root) {
        return json_error(m_logger, req, http::status::not_found, error, tag);
    }

    auto it = root->find(*key);
    if (it == root->end()) {
        return json_error(m_logger, req, http::status::not_found, "preset <" + *key + "> not found", tag);
    }
    root->erase(it);

    // Запись через временный файл: сбой посреди записи не оставит файл пустым
    const auto tmp = path.string() + ".tmp";
    {
        std::ofstream out(tmp, std::ios::trunc);
        if (!out.is_open()) {
            return json_error(m_logger, req, http::status::internal_server_error,
                "cannot write " + tmp, tag);
        }
        out << boost::json::serialize(*root);
    }

    std::error_code ec;
    std::filesystem::rename(tmp, path, ec);
    if (ec) {
        return json_error(m_logger, req, http::status::internal_server_error,
            "cannot replace presets file: " + ec.message(), tag);
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
        const auto params = m_linker->get_stream_params();

        data["running"] = m_linker->is_running();
        data["export_id"] = m_linker->get_active_export_id();
        // Пока поток не поднят, get_stream_id() пуст — отдаём то, с чем он стартует
        data["stream_id"] = m_linker->is_running() ? m_linker->get_stream_id() : params.stream_id;
        data["stream_name"] = params.stream_name;
        data["fps"] = static_cast<int64_t>(params.fps);
        data["rotation"] = m_linker->resolve_rotation();
        data["view_mode"] = m_linker->resolve_view_mode();

        /*
            Размер кадра шире канваса на выравнивание сторон, поэтому он
            уходит наружу отдельно: иначе при разборе размер в потоке не
            сойдётся с размером в конфигурации. Нули — вывод не запускался.
        */
        const auto [out_w, out_h] = m_linker->get_output_size();
        data["width"] = static_cast<int64_t>(out_w);
        data["height"] = static_cast<int64_t>(out_h);

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

        // Индекс экспортов, а не пресеты проекции: здесь ищут по export_id,
        // и list_exports() читает именно этот файл
        auto index_path = m_linker->get_exports_index_path();
        if (!std::filesystem::exists(index_path)) {
            return json_error(m_logger, req, http::status::not_found,
                "exports index not found at " + index_path.string(), tag);
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

        // Угол кладём в ответ, чтобы клиенту не пришлось выводить его самому:
        // правило по форме канваса должно жить в одном месте
        auto record = it->value().as_object();
        record["rotation"] = m_linker->resolve_rotation(*export_id);

        boost::json::object body;
        body["data"] = std::move(record);

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

        /*
            Мёрж с переносом разметки. Конфигуратор владеет геометрией пресета,
            но ничего не знает про src-точки и привязки камер со страницы
            сборки: его payload несёт пустые src_points. Замена записи целиком
            стирала бы разметку при каждом пересохранении пресета.
        */
        for (auto& kv : config_obj) {
            const std::string key(kv.key());

            const auto* old_entry = index.if_contains(key);
            if (old_entry && old_entry->is_object() && kv.value().is_object()) {
                auto& new_obj = kv.value().as_object();
                const auto& old_obj = old_entry->as_object();
                const auto* old_cams_v = old_obj.if_contains("cameras");
                auto* new_cams_v = new_obj.if_contains("cameras");
                if (old_cams_v && old_cams_v->is_object()
                    && new_cams_v && new_cams_v->is_object()) {
                    const auto& old_cams = old_cams_v->as_object();
                    for (auto& cam_kv : new_cams_v->as_object()) {
                        const auto* old_cam_v = old_cams.if_contains(cam_kv.key());
                        if (!old_cam_v || !old_cam_v->is_object()
                            || !cam_kv.value().is_object()) continue;
                        auto& new_cam = cam_kv.value().as_object();
                        const auto& old_cam = old_cam_v->as_object();

                        const auto* sp = new_cam.if_contains("src_points");
                        if (!sp || !sp->is_array() || sp->as_array().empty()) {
                            if (const auto* osp = old_cam.if_contains("src_points")) {
                                new_cam["src_points"] = *osp;
                            }
                        }
                        if (!new_cam.contains("camera_id")) {
                            if (const auto* oid = old_cam.if_contains("camera_id")) {
                                new_cam["camera_id"] = *oid;
                            }
                        }
                        if (!new_cam.contains("calibration")) {
                            if (const auto* oc = old_cam.if_contains("calibration")) {
                                new_cam["calibration"] = *oc;
                            }
                        }
                    }
                }
            }

            index[key] = kv.value();
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

// ─── POST /linker/upload-model ──────────────────────────────
/*
    Модель .glb в общую библиотеку моделей. Только glTF-binary: первые
    четыре байта данных обязаны быть магией "glTF". Привязку к конфигурации
    делает отдельный POST /linker/surround {model:{source}}.
*/
http::response<http::string_body>
ULinkerController::post_upload_model(const http::request<http::string_body>& req)
{
    const std::string tag = "POST /linker/upload-model";
    log_request(m_logger, req, tag);

    try {
        auto content_type = std::string(req[http::field::content_type]);

        auto pos = content_type.find("boundary=");
        if (pos == std::string::npos) {
            return json_error(m_logger, req, http::status::bad_request,
                "missing boundary in content-type", tag);
        }
        std::string boundary = "--" + content_type.substr(pos + 9);

        const auto& body = req.body();

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
        if (filename.size() < 5
            || filename.substr(filename.size() - 4) != ".glb") {
            return json_error(m_logger, req, http::status::bad_request,
                "model must be a .glb file", tag);
        }

        auto header_end = body.find("\r\n\r\n", fn_pos);
        if (header_end == std::string::npos) {
            return json_error(m_logger, req, http::status::bad_request, "malformed multipart", tag);
        }
        auto data_start = header_end + 4;

        auto data_end = body.find(boundary, data_start);
        if (data_end == std::string::npos) {
            data_end = body.size();
        }
        if (data_end >= 2 && body[data_end - 2] == '\r' && body[data_end - 1] == '\n') {
            data_end -= 2;
        }

        // Магия glTF-binary в начале данных, расширению веры нет
        if (data_end - data_start < 12 || body.compare(data_start, 4, "glTF") != 0) {
            return json_error(m_logger, req, http::status::bad_request,
                "file is not a binary glTF (glb)", tag);
        }

        auto models_dir = m_linker->get_models_list_path();
        std::filesystem::create_directories(models_dir);

        auto file_path = models_dir / filename;
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

// ─── GET /linker/models ─────────────────────────────────────
// Библиотека .glb: имя и размер каждого файла, панель показывает список
http::response<http::string_body>
ULinkerController::get_models(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /linker/models";
    log_request(m_logger, req, tag);

    try {
        boost::json::array models;
        const auto dir = m_linker->get_models_list_path();
        if (std::filesystem::exists(dir)) {
            for (const auto& entry : std::filesystem::directory_iterator(dir)) {
                if (!entry.is_regular_file()) continue;
                if (entry.path().extension() != ".glb") continue;
                boost::json::object item;
                item["name"] = entry.path().filename().string();
                item["size"] = static_cast<int64_t>(entry.file_size());
                models.push_back(std::move(item));
            }
        }

        boost::json::object data;
        data["models"] = std::move(models);
        boost::json::object body;
        body["data"] = std::move(data);

        return json_ok(m_logger, req, body, tag);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}

// ─── GET /linker/image?name=XXX ─────────────────────────────
/*
    Картинка-подложка пресета.

    Тело идёт обычным string_body: это std::string, он несёт двоичные данные
    как есть. Роутер умеет только string_body, а прежняя реализация на
    file_body через него пройти не могла и потому нигде не была подключена.
*/
http::response<http::string_body>
ULinkerController::get_image(const http::request<http::string_body>& req) {
    namespace fs = std::filesystem;
    const std::string tag = "GET /linker/image";
    log_request(m_logger, req, tag);

    auto filename = get_query_param(std::string(req.target()), "name");
    if (!filename || filename->empty()) {
        return json_error(m_logger, req, http::status::bad_request, "missing name parameter", tag);
    }

    // Имя уходит в путь: разделители и переходы наверх пускать нельзя
    if (filename->find('/') != std::string::npos
        || filename->find('\\') != std::string::npos
        || filename->find("..") != std::string::npos)
    {
        return json_error(m_logger, req, http::status::bad_request, "invalid name", tag);
    }

    const auto image_path = m_linker->get_images_list_path() / *filename;
    if (!fs::exists(image_path) || fs::is_directory(image_path)) {
        return json_error(m_logger, req, http::status::not_found, "image not found", tag);
    }

    std::ifstream file(image_path, std::ios::binary);
    if (!file.is_open()) {
        return json_error(m_logger, req, http::status::internal_server_error, "cannot open image", tag);
    }

    std::string bytes{ std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>() };

    const auto ext = image_path.extension().string();
    std::string mime = "application/octet-stream";
    if (ext == ".png") mime = "image/png";
    else if (ext == ".jpg" || ext == ".jpeg") mime = "image/jpeg";
    else if (ext == ".webp") mime = "image/webp";
    else if (ext == ".bmp") mime = "image/bmp";

    http::response<http::string_body> res{ http::status::ok, req.version() };
    res.set(http::field::content_type, mime);
    res.keep_alive(req.keep_alive());
    res.body() = std::move(bytes);
    res.prepare_payload();
    return res;
}