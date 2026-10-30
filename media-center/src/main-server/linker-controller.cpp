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
        // Живой режим орбиты — кнопки плееров синхронизируются по нему
        data["orbit_manual"] = m_linker->is_orbit_manual();
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

        // Второй поток при включённом тумблере; null - вывод одиночный
        data["dual_output"] = m_linker->resolve_dual_output();
        const auto second = m_linker->get_secondary_output();
        if (second.stream_id.empty()) {
            data["secondary"] = nullptr;
        }
        else {
            boost::json::object s;
            s["stream_id"] = second.stream_id;
            s["view_mode"] = second.view_mode;
            s["width"] = static_cast<int64_t>(second.width);
            s["height"] = static_cast<int64_t>(second.height);
            data["secondary"] = std::move(s);
        }

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