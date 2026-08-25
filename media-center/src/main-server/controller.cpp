#include "main-server/controller.h"
#include <boost/json.hpp>
#include <algorithm>
#include <regex>
#include <sstream>
#include <unordered_set>

#include "nvr/constants.h"
#include "nvr/stream-probe.h"
#include "utility/rtsp-url.h"
#include "utility/json-utils.h"

#include "main-server/helpers.h"

namespace http = boost::beast::http;
namespace json = boost::json;

using namespace varan::neural;
using namespace varan::nvr;
using namespace varan::rest;

namespace {

    /*
        Ключ потока уходит наружу — в путь записи и в адрес webrtc-сессии,
        поэтому форма у него жёсткая, а переименования нет.
    */
    const std::regex STREAM_KEY_REGEX("^stream_[1-9][0-9]*$");

    // Разбор одного потока. Общий для POST и PATCH: раньше он был скопирован
    // в обе ручки, и проверки в них успевали разойтись
    FPipelineConfig parse_stream_config(const std::string& name, const json::object& obj) {
        if (!std::regex_match(name, STREAM_KEY_REGEX)) {
            throw std::runtime_error("Stream key \"" + name + "\" must look like stream_N");
        }

        FPipelineConfig config;

        config.name = name;
        config.type = EPilelineType::CAMERA;

        config.channel = obj.contains(fields::CHANNEL)
            ? static_cast<int>(get_json_value<int64_t>(obj.at(fields::CHANNEL), fields::CHANNEL))
            : varan::nvr::constants::MIN_CHANNEL;

        config.substream = static_cast<int>(get_json_value<int64_t>(obj.at(fields::SUBSTREAM), fields::SUBSTREAM));

        if (config.channel < varan::nvr::constants::MIN_CHANNEL || config.channel > varan::nvr::constants::MAX_CHANNEL) {
            throw std::runtime_error("Stream " + name + ": channel is out of range "
                + std::to_string(varan::nvr::constants::MIN_CHANNEL) + "..." + std::to_string(varan::nvr::constants::MAX_CHANNEL));
        }

        if (config.substream < varan::nvr::constants::MIN_SUBSTREAM || config.substream > varan::nvr::constants::MAX_SUBSTREAM) {
            throw std::runtime_error("Stream " + name + ": substream is out of range "
                + std::to_string(varan::nvr::constants::MIN_SUBSTREAM) + "..." + std::to_string(varan::nvr::constants::MAX_SUBSTREAM));
        }

        const auto& purposes = obj.at(fields::PURPOSES);
        if (!purposes.is_array() || purposes.as_array().empty()) {
            throw std::runtime_error("Stream " + name + ": purposes must be a non-empty array of strings");
        }

        for (const auto& item : purposes.as_array()) {
            if (!item.is_string()) {
                throw std::runtime_error("Stream " + name + ": purpose must be a string");
            }

            const std::string value = item.as_string().c_str();
            const auto purpose = purpose_from_string(value);

            if (!purpose) {
                throw std::runtime_error("Stream " + name + ": unknown purpose \"" + value + "\"");
            }
            if (config.purposes.has(*purpose)) {
                throw std::runtime_error("Stream " + name + ": purpose \"" + value + "\" is listed twice");
            }

            config.purposes.add(*purpose);
        }

        config.latency = static_cast<int>(get_json_value<int64_t>(obj.at(fields::LATENCY), fields::LATENCY));
        config.use_udp = get_json_value<bool>(obj.at(fields::USE_UDP), fields::USE_UDP);
        config.reconnect_delay = static_cast<int>(get_json_value<int64_t>(obj.at(fields::RECONNECT), fields::RECONNECT));

        // Путь и длина сегмента без записи не значат ничего
        if (config.purposes.record) {
            config.record_path = get_json_value<std::string>(obj.at(fields::RECORD_PATH), fields::RECORD_PATH);
            config.segment_length = static_cast<int>(get_json_value<int64_t>(obj.at(fields::SEGMENT_LENGTH), fields::SEGMENT_LENGTH));
        }
        else {
            config.record_path.clear();
            config.segment_length = 0;
        }

        return config;
    }

} // namespace

UController::UController(std::shared_ptr<UMediaCenter> media_center, ULogger* logger)
    : m_media_center(media_center)
    , m_logger(logger)
{}

void UController::set_virtual_streams_provider(CVirtualStreamsProvider provider) {
    m_virtual_streams = std::move(provider);
}

// GET /camera?name=XXX
http::response<http::string_body>
UController::get_camera(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /camera";
    log_request(m_logger, req, tag);

    http::response<http::string_body> res{ http::status::ok, req.version() };
    res.set(http::field::content_type, "application/json");
    res.keep_alive(req.keep_alive());

    boost::json::object body;

    try {
        std::string_view target = req.target();
        std::unordered_map<std::string, std::string> selectors;
        std::set<std::string> fields;

        if (auto pos = target.find('?'); pos != std::string_view::npos) {
            std::string_view query = target.substr(pos + 1);
            parse_query(query, selectors, fields);
        }

        auto cameras_data = m_media_center->get_cameras();
        std::vector<FCameraStreamsData> matched_data;

        // Проходим селекуторы, если они есть
        if (!selectors.empty()) {
            for (auto& data : cameras_data) {
                auto matched = match_data_with_selectors(selectors, data);
                if (matched.has_value()) {
                    matched_data.push_back(std::move(matched.value()));
                }
            }
        }
        else {
            matched_data = std::move(cameras_data);
        }

        boost::json::object data;
        if (matched_data.empty()) {
            data[fields::CAMERAS] = boost::json::value(nullptr);
        }
        else {
            boost::json::object cameras;
            for (const auto& data : matched_data) {
                auto current = make_camera_json(data, fields);
                if (!current.empty()) {
                    cameras[data.camera.id] = current;
                }
            }
            data[fields::CAMERAS] = cameras.empty() ? boost::json::value(nullptr) : cameras;
        }

        // Только для запроса всего списка, выборка по id спрашивает про камеру
        if (selectors.empty() && m_virtual_streams) {
            data[fields::VIRTUAL_STREAMS] = m_virtual_streams();
        }

        // Собираем итоговый
        body = create_answer_message(data, std::nullopt, std::nullopt);
        const std::string body_str = json::serialize(body);
        //if (m_logger) m_logger->send(tag + " → " + body_str);
        res.body() = body_str;
    }
    catch (const std::exception& e) {
        log_error(m_logger, tag, e.what());

        boost::json::object error;
        error[fields::ERROR_CODE] = 402;
        error[fields::ERROR_MESSAGE] = "Internatl error: " + std::string(e.what());
        error[fields::ERROR_DETAILS] = boost::json::value(nullptr);

        body = create_answer_message(std::nullopt, std::nullopt, error);
        res.result(http::status::internal_server_error);
        res.body() = boost::json::serialize(body);
    }

    res.prepare_payload();
    return res;
}

// POST /camera  { "name":"cam1", "ip":"192.168.1.10", "port":5000 }
http::response<http::string_body>
UController::post_camera(const http::request<http::string_body>& req) 
{
    const std::string tag = "POST /camera";
    log_request(m_logger, req, tag);

    http::response<http::string_body> res{ http::status::created, req.version() };
    res.set(http::field::content_type, "application/json");
    res.keep_alive(req.keep_alive());

    try {
        json::object body;
        json::value jv = json::parse(req.body());
        if (!jv.is_object()) {
            throw std::runtime_error("Invalid JSON body");
        }
        json::object obj = jv.as_object();
        // Проверка полей в пост запросе
        for (const auto& field : m_post_camera_fields) {
            if (!obj.contains(field)) {
                throw std::runtime_error("Missing field: " + field);
            }
        }
        if (!obj[fields::STREAMS].is_object()) {
            throw std::runtime_error("Stream field is not json object!");
        }
        auto obj_streams = obj[fields::STREAMS].as_object();
        // Проверка уникальности имени камер
        std::string id = obj[fields::ID].as_string().c_str();
        if (m_media_center->camera_exists(id)) {
            throw std::runtime_error("Camera with id \"" + id + "\" already exists!");
        }
        // Создание ссылки на камеру

        auto prod = int_to_count_enum<ERtspType>(get_json_value<int64_t>(obj[fields::PRODUCTION], fields::PRODUCTION));
        if (prod == std::nullopt) {
            throw std::runtime_error("Not supported camera production!");
        }
        std::string display_name = obj.contains(fields::DISPLAY_NAME) ? obj[fields::DISPLAY_NAME].as_string().c_str(): "имя не установлено";
        std::string description = obj.contains(fields::DESCRIPTION) ? obj[fields::DESCRIPTION].as_string().c_str() : "без описания";
        // Получение ссылки
        std::string ip_adress = get_json_value<std::string>(obj[fields::IP_ADRESS], fields::IP_ADRESS);
        std::string port = get_json_value<std::string>(obj[fields::PORT], fields::PORT);
        std::string user = get_json_value<std::string>(obj[fields::USER], fields::USER);
        std::string password = get_json_value<std::string>(obj[fields::PASSWORD], fields::PASSWORD);
        // Тип камеры больше не принимается: что делает поток, решают его назначения
        if (obj.contains(fields::CAMERA_TYPE) && m_logger) {
            m_logger->send(tag + ": field <type> is obsolete and ignored, purposes are taken from streams");
        }

        FCameraData camera_data = {id, display_name, description, ip_adress, port, user, password, prod.value()};

        std::map<std::string, FPipelineConfig> pipelines;
        // Парсинг объекта pipeline
        for (auto const& [name_stream, stream] : obj_streams) {
            if (!stream.is_object()) {
                throw std::runtime_error("Stream \"" + std::string(name_stream) + "\" is not json object!");
            }

            const auto& stream_obj = stream.as_object();
            // Проверка полей стримов
            for (const auto& field : m_post_stream_fields) {
                if (!stream_obj.contains(field)) {
                    throw std::runtime_error("Stream \"" + std::string(name_stream) + "\" does not contain the required field <" + field + ">");
                }
            }

            const std::string name(name_stream);
            // Ключи внутри json уникальны сами по себе, отдельная проверка не нужна
            pipelines[name] = parse_stream_config(name, stream_obj);
        }

        if (const auto error = m_media_center->validate_streams(pipelines)) {
            throw std::runtime_error(*error);
        }

        if (m_media_center->add_camera_async(camera_data, pipelines, true)) {
            body[fields::RESULT] = "success";
            body[fields::ERROR_DETAILS] = "Camera \"" + id + "\" successfully added to nvr!";

            auto answer = create_answer_message(body, std::nullopt, std::nullopt);
            const std::string body_str = json::serialize(answer);
            if (m_logger) m_logger->send(tag + " → " + body_str);
            res.body() = body_str;
        }
        else {
            throw std::runtime_error("Camera \"" + id + "\" cannot be added");
        }

    }
    catch (const std::exception& e) {
        log_error(m_logger, tag, e.what());

        res.result(http::status::bad_request);
        json::object error;
        error[fields::ERROR_CODE] = 402;
        error[fields::ERROR_MESSAGE] = "Bad Request";
        error[fields::ERROR_DETAILS] = e.what();

        res.body() = json::serialize(create_answer_message(std::nullopt, std::nullopt, error));
    }

    res.prepare_payload();
    return res;
}

// PATCH /camera?id=
// Body (все поля опциональны):
// { "display_name":"...", "description":"...", "streams": { ... } }
http::response<http::string_body>
UController::patch_camera(const http::request<http::string_body>& req)
{
    const std::string tag = "PATCH /camera?id=";
    log_request(m_logger, req, tag);

    http::response<http::string_body> res{ http::status::created, req.version() };
    res.set(http::field::content_type, "application/json");
    res.keep_alive(req.keep_alive());

    try {
        json::object body;
        // Парсинг строки URL
        std::string_view target = req.target();
        std::unordered_map<std::string, std::string> selectors;
        std::set<std::string> fields;

        if (auto pos = target.find('?'); pos != std::string_view::npos) {
            std::string_view query = target.substr(pos + 1);
            parse_query(query, selectors, fields);
        }

        // Поиск камеры
        std::optional<std::string> camera_id;
        std::shared_ptr<UCamera> found_camera = nullptr;
        if (selectors.empty()) {
            throw std::runtime_error("The request body is empty when trying to patch a camera. "
                "Please specify the camera name as a query parameter, for example: ?id=camera_name.");
        }
        else {
            for (const auto& [field, value] : selectors) {
                if (field == fields::ID) {
                    found_camera = m_media_center->get_camera(value);
                    if (!found_camera) {
                        res.result(http::status::not_found);
                        json::object error;
                        error[fields::ERROR_CODE] = 404;
                        error[fields::ERROR_MESSAGE] = "Not Found";
                        error[fields::ERROR_DETAILS] = "Camera \"" + value + "\" does not exist";
                        res.body() = json::serialize(create_answer_message(std::nullopt, std::nullopt, error));
                        res.prepare_payload();
                        return res;
                    }
                    camera_id = value;
                    break;
                }
            }
        }
        // Проверка прошла, можно приступить к JSON body
        // Парсинг тела json
        json::value jv = json::parse(req.body());
        if (!jv.is_object()) {
            throw std::runtime_error("Invalid JSON body");
        }
        json::object obj = jv.as_object();
        // Проверка структуры тела JSON
        bool has_meta = obj.contains("meta");
        bool has_critical = obj.contains("critical");

        if (!has_meta && !has_critical) {
            throw std::runtime_error("Empty PATCH: no meta or critical section provided");
        }
        // Назначение опциональные параметры
        std::optional<FCameraData> patch_camera_options = std::nullopt;
        std::optional<std::map<std::string, FPipelineConfig>> patch_streams_data = std::nullopt;
        // Получаем текущие данные с камеры
        auto current_data = found_camera->get_data();
        auto current_camera_options = current_data.camera;
        // Проверяем структуру каждого блока
        if (has_meta) {
            if (!obj["meta"].is_object()) {
                throw std::runtime_error("meta must be an object");
            }
            auto meta = obj["meta"].as_object();

            std::optional<std::string> display_name;
            std::optional<std::string> description;

            if (meta.contains(fields::DISPLAY_NAME) && meta[fields::DISPLAY_NAME].is_string()) {
                display_name = meta[fields::DISPLAY_NAME].as_string().c_str();
            }

            if (meta.contains(fields::DESCRIPTION) && meta[fields::DESCRIPTION].is_string()) {
                description = meta[fields::DESCRIPTION].as_string().c_str();
            }

            if (!display_name && !description) {
                throw std::runtime_error("No fields at meta block to update were provided");
            }
            // Обновление метаданных
            current_camera_options.display_name = display_name ? display_name.value() : current_camera_options.display_name;
            current_camera_options.description = description ? description.value() : current_camera_options.description;
            // Применяем его к нашим баранам
            patch_camera_options = current_camera_options;
        }
        if (has_critical) {
            if (!obj["critical"].is_object()) {
                throw std::runtime_error("critical must be an object");
            }
            auto crit = obj["critical"].as_object();

            // Проверка всех обязательных полей
            for (const auto& field : m_post_camera_fields) {
                if (field == fields::DISPLAY_NAME || field == fields::DESCRIPTION || field == fields::ID || field == fields::PASSWORD) {
                    continue;
                }

                if (!crit.contains(field)) {
                    throw std::runtime_error("critical missing field: " + field);
                }
            }
            if (!crit[fields::STREAMS].is_object()) {
                throw std::runtime_error("Stream field is not json object!");
            }
            auto obj_streams = crit[fields::STREAMS].as_object();

            auto prod = int_to_count_enum<ERtspType>(get_json_value<int64_t>(crit[fields::PRODUCTION], fields::PRODUCTION));
            if (prod == std::nullopt) {
                throw std::runtime_error("Not supported camera production!");
            }
            // Получение ссылки
            std::string ip_adress = get_json_value<std::string>(crit[fields::IP_ADRESS], fields::IP_ADRESS);
            std::string port = get_json_value<std::string>(crit[fields::PORT], fields::PORT);
            std::string user = get_json_value<std::string>(crit[fields::USER], fields::USER);
            std::string password = crit.contains(fields::PASSWORD) ? get_json_value<std::string>(crit[fields::PASSWORD], fields::PASSWORD) 
                                                                   : current_camera_options.password;
            // Тип камеры больше не принимается: назначения живут на потоках
            if (crit.contains(fields::CAMERA_TYPE) && m_logger) {
                m_logger->send(tag + ": field <type> is obsolete and ignored, purposes are taken from streams");
            }

            FCameraData camera_data = {
                *camera_id, 
                patch_camera_options ? patch_camera_options.value().display_name : current_camera_options.display_name,
                patch_camera_options ? patch_camera_options.value().description : current_camera_options.description,
                ip_adress, port, user, password, prod.value()
            };

            std::map<std::string, FPipelineConfig> pipelines;
            // Парсинг объекта pipeline
            for (auto const& [name_stream, stream] : obj_streams) {
                if (!stream.is_object()) {
                    throw std::runtime_error("Stream \"" + std::string(name_stream) + "\" is not json object!");
                }
                const auto& stream_obj = stream.as_object();
                // Проверка полей стримов
                for (const auto& field : m_post_stream_fields) {
                    if (!stream_obj.contains(field)) {
                        throw std::runtime_error("Stream \"" + std::string(name_stream) + "\" does not contain the required field <" + field + ">");
                    }
                }

                const std::string name(name_stream);
                pipelines[name] = parse_stream_config(name, stream_obj);
            }

            if (const auto error = m_media_center->validate_streams(pipelines)) {
                throw std::runtime_error(*error);
            }

            patch_camera_options = camera_data;
            patch_streams_data = pipelines;
        }
        // Изменяем pipeline
        if (m_media_center->update_camera(*camera_id, patch_camera_options, patch_streams_data, true)) {
            json::object body;
            body[fields::RESULT] = "success";
            body[fields::ERROR_DETAILS] = "Camera \"" + *camera_id + "\" successfully updated";

            auto answer = create_answer_message(body, std::nullopt, std::nullopt);
            const std::string body_str = json::serialize(answer);
            if (m_logger) m_logger->send(tag + " → " + body_str);
            res.body() = body_str;
        }
        else {
            throw std::runtime_error("cannot update camera");
        }
    }
    catch (const std::exception& e) {
        log_error(m_logger, tag, e.what());

        res.result(http::status::bad_request);
        json::object error;
        error[fields::ERROR_CODE] = 402;
        error[fields::ERROR_MESSAGE] = "Bad Request";
        error[fields::ERROR_DETAILS] = e.what();

        res.body() = json::serialize(create_answer_message(std::nullopt, std::nullopt, error));
    }

    res.prepare_payload();
    return res;
}

// POST /probe { ip_adress, port, user, password, production, channel, substream, timeout }
http::response<http::string_body>
UController::post_probe(const http::request<http::string_body>& req) {
    const std::string tag = "POST /probe";
    log_request(m_logger, req, tag);

    http::response<http::string_body> res{ http::status::ok, req.version() };
    res.set(http::field::content_type, "application/json");
    res.keep_alive(req.keep_alive());

    try {
        auto parsed = json::parse(req.body());
        if (!parsed.is_object()) {
            throw std::runtime_error("Request body isn't json object");
        }

        const auto& obj = parsed.as_object();

        for (const auto& field : { fields::IP_ADRESS, fields::PORT, fields::USER, fields::PRODUCTION }) {
            if (!obj.contains(field)) {
                throw std::runtime_error("Missing required field <" + field + ">");
            }
        }

        const auto production = int_to_count_enum<ERtspType>(
            get_json_value<int64_t>(obj.at(fields::PRODUCTION), fields::PRODUCTION));

        if (production == std::nullopt) {
            throw std::runtime_error("Unknow camera production");
        }

        const std::string ip_adress = get_json_value<std::string>(obj.at(fields::IP_ADRESS), fields::IP_ADRESS);
        const std::string port = get_json_value<std::string>(obj.at(fields::PORT), fields::PORT);
        const std::string user = get_json_value<std::string>(obj.at(fields::USER), fields::USER);
        const std::string password = obj.contains(fields::PASSWORD)
            ? get_json_value<std::string>(obj.at(fields::PASSWORD), fields::PASSWORD)
            : "";

        const int channel = obj.contains(fields::CHANNEL)
            ? static_cast<int>(get_json_value<int64_t>(obj.at(fields::CHANNEL), fields::CHANNEL))
            : varan::nvr::constants::MIN_CHANNEL;

        const int substream = obj.contains(fields::SUBSTREAM)
            ? static_cast<int>(get_json_value<int64_t>(obj.at(fields::SUBSTREAM), fields::SUBSTREAM))
            : varan::nvr::constants::MIN_SUBSTREAM;

        if (channel < varan::nvr::constants::MIN_CHANNEL || channel > varan::nvr::constants::MAX_CHANNEL) {
            throw std::runtime_error("The channel is out of the acceptable range");
        }
        if (substream < varan::nvr::constants::MIN_SUBSTREAM || substream > varan::nvr::constants::MAX_SUBSTREAM) {
            throw std::runtime_error("The stream is out of the acceptable range");
        }

        int timeout = obj.contains(fields::TIMEOUT)
            ? static_cast<int>(get_json_value<int64_t>(obj.at(fields::TIMEOUT), fields::TIMEOUT))
            : 3;
        timeout = std::clamp(timeout, 1, 10);

        // Ссылка строится тем же шаблоном, что и у камеры: проба должна
        // проверять ровно то, что потом пойдёт в поток
        const auto it_maker = rtsp_maker.find(*production);
        const auto& maker = (it_maker != rtsp_maker.end()) ? it_maker->second : rtsp_maker.at(ERtspType::ACE);
        const std::string rtsp_url = maker(ip_adress, port, user, password, channel, substream);

        const auto probe = probe_stream(rtsp_url, timeout, m_logger);

        json::object body;
        if (probe.ok) {
            body[fields::RESULT] = "success";
            body[fields::CODEC] = probe.codec;
            body[fields::WIDTH] = probe.width;
            body[fields::HEIGHT] = probe.height;
            body[fields::FPS] = probe.fps;
        }
        else {
            body[fields::RESULT] = "error";
            body[fields::REASON] = probe_reason_to_string(probe.reason);
            body[fields::ERROR_DETAILS] = probe.details;
        }

        const std::string body_str = json::serialize(create_answer_message(body, std::nullopt, std::nullopt));
        if (m_logger) m_logger->send(tag + " → " + body_str);
        res.body() = body_str;
    }
    catch (const std::exception& e) {
        log_error(m_logger, tag, e.what());

        res.result(http::status::bad_request);
        json::object error;
        error[fields::ERROR_CODE] = 402;
        error[fields::ERROR_MESSAGE] = "Bad Request";
        error[fields::ERROR_DETAILS] = e.what();

        res.body() = json::serialize(create_answer_message(std::nullopt, std::nullopt, error));
    }

    res.prepare_payload();
    return res;
}

// DELETE /camera?id=XXX
http::response<http::string_body>
UController::delete_camera(const http::request<http::string_body>& req) {
    const std::string tag = "DELETE /camera?id=XXX";
    log_request(m_logger, req, tag);

    http::response<http::string_body> res{ http::status::ok, req.version() };
    res.set(http::field::content_type, "application/json");
    res.keep_alive(req.keep_alive());

    boost::json::object body;

    try {
        std::string_view target = req.target();
        std::unordered_map<std::string, std::string> selectors;
        std::set<std::string> fields;

        if (auto pos = target.find('?'); pos != std::string_view::npos) {
            std::string_view query = target.substr(pos + 1);
            parse_query(query, selectors, fields);
        }

        if (selectors.empty()) {
            throw std::runtime_error("The request body is empty when trying to delete a camera. "
                "Please specify the camera name as a query parameter, for example: ?name=camera_name.");
        }
        else {
            for (const auto& [field, value] : selectors) {
                if (field == fields::ID) {
                    auto exists = m_media_center->camera_exists(value);
                    if (!exists) {
                        throw std::runtime_error("Camera with name " + value + " doesn't exist in nvr!");
                    }

                    m_media_center->remove_camera_async(value, true);

                    body[fields::RESULT] = "success";
                    body[fields::ERROR_DETAILS] = "Camera with name " + value + " successfully pended to delete!";
                    const std::string body_str = json::serialize(create_answer_message(body, std::nullopt, std::nullopt));
                    if (m_logger) m_logger->send(tag + " → " + body_str);
                    res.body() = body_str;
                    break;
                }
            }
        }
    }
    catch (const std::exception& e) {
        log_error(m_logger, tag, e.what());
        res.result(http::status::bad_request);
        body[fields::ERROR_CODE] = 402;
        body[fields::ERROR_MESSAGE] = "Bad Request";
        body[fields::ERROR_DETAILS] = e.what();
        res.body() = json::serialize(create_answer_message(std::nullopt, std::nullopt, body));
    }

    res.prepare_payload();
    return res;
}

std::optional<FCameraStreamsData> UController::match_data_with_selectors(
    const std::unordered_map<std::string, std::string>& selectors, 
    FCameraStreamsData& data)
{
    size_t camera_counts = 0; 
    std::unordered_map<std::string, size_t> stream_counts;
    for (const auto& [key, _] : data.pipelines) {
        stream_counts[key] = 0;
    }

    for (const auto& [field, value] : selectors) {
        if (field.starts_with(fields::STREAMS + ".")) {
            try {
                for (const auto& [name, stream]: data.pipelines) {
                    auto prefix = fields::STREAMS + ".";
                    std::string key_stream = field.substr(prefix.length());

                    auto& counter = stream_counts[name];

                    if (key_stream == fields::NAME) counter += value == stream.name;
                    // Фильтр по одному назначению: streams.purposes=neural
                    else if (key_stream == fields::PURPOSES) {
                        const auto purpose = purpose_from_string(value);
                        counter += purpose && stream.purposes.has(*purpose);
                    }
                    else if (key_stream == fields::STATUS) counter += std::stoi(value) == static_cast<int>(stream.status);

                    else if (key_stream == fields::RTSP_URL) counter += value == stream.rtsp_url;
                    else if (key_stream == fields::WIDTH) counter += std::stoi(value) == static_cast<int>(stream.width);
                    else if (key_stream == fields::HEIGHT) counter += std::stoi(value) == static_cast<int>(stream.height);
                    else if (key_stream == fields::LATENCY) counter += std::stoi(value) == static_cast<int>(stream.latency);
                    else if (key_stream == fields::CODEC) counter += value == stream.codec;

                    else if (key_stream == fields::RECORD_PATH) counter += value == stream.record_path;
                    else if (key_stream == fields::SEGMENT_LENGTH) counter += std::stoi(value) == static_cast<int>(stream.segment_length);
                    else if (key_stream == fields::RECONNECT) counter += std::stoi(value) == static_cast<int>(stream.reconnect_time);
                }
            }
            catch (const std::exception& e) {
                // логгирование
                return std::nullopt;
            }
        }
        else {
            if (field == fields::ID) camera_counts += value == data.camera.id;
            else if (field == fields::DISPLAY_NAME) camera_counts += value == data.camera.display_name;
            else if (field == fields::DESCRIPTION) camera_counts += value == data.camera.description;
            else if (field == fields::PRODUCTION) camera_counts += std::stoi(value) == static_cast<int>(data.camera.production);
            else if (field == fields::IP_ADRESS) camera_counts += value == data.camera.ip_adress;
            else if (field == fields::PORT) camera_counts += value == data.camera.port;
            else if (field == fields::USER) camera_counts += value == data.camera.user;
            else if (field == fields::PASSWORD) camera_counts += value == data.camera.password;
        }
    }
    size_t previous_size = data.pipelines.size();
    FCameraStreamsData camera_data;

    size_t max_value = 0;
    for (const auto& [key, value] : stream_counts) {
        max_value = std::max(max_value, value);
    }

    if (camera_counts + max_value == selectors.size()) {
        camera_data.camera = data.camera;
    }
    else {
        return std::nullopt;
    }

    for (const auto& [key, value] : stream_counts) {
        if (camera_counts + value == selectors.size()) {
            auto node = data.pipelines.extract(key);
            if (!node.empty()) {
                camera_data.pipelines.insert(std::move(node));
            }
        }
    }

    return camera_data;
}

void UController::parse_query(
    std::string_view query, 
    std::unordered_map<std::string, std::string>& selections, 
    std::set<std::string>& fields
) {
    while (!query.empty()) {
        auto eq = query.find('=');
        if (eq == std::string_view::npos) break;

        auto key = query.substr(0, eq);
        query.remove_prefix(eq + 1);

        auto amp = query.find('&');
        auto value = query.substr(0, amp);

        if (key == fields::FIELDS) {
            std::string line_copy = std::string(value);
            std::stringstream ss(line_copy);
            std::string field;
            while (std::getline(ss, field, ',')) {
                if (!field.empty()) {
                    fields.insert(field);
                }
            }
        }
        else {
            selections[std::string(key)] = std::string(value);
        }

        if (amp == std::string_view::npos) break;

        query.remove_prefix(amp + 1);
    }
}

boost::json::object UController::make_camera_json(const FCameraStreamsData& data, const std::set<std::string>& fields) {
    json::object obj;

    if (fields.empty()) {
        for (const auto& [key, writer] : m_camera_field_map) {
            writer(data, obj);
        }
        return obj;
    }

    const std::string prefix = fields::STREAMS + ".";

    std::vector<std::string> camera_fields;
    std::vector<std::string> stream_fields;

    for (const auto& field : fields) {
        if (field.starts_with(prefix)) {
            stream_fields.push_back(field.substr(prefix.size()));
        }
        else {
            camera_fields.push_back(field);
        }
    }

    // Поля камеры
    for (const auto& field : camera_fields) {
        auto it = m_camera_field_map.find(field);
        if (it != m_camera_field_map.end()) {
            it->second(data, obj);
        }
    }

    // Поля потоков
    if (!stream_fields.empty()) {
        json::object streams_obj;
        for (const auto& [name, pipe] : data.pipelines) {
            streams_obj[name] = make_pipeline_json(pipe, stream_fields);
        }
        if (!streams_obj.empty()) {
            obj[fields::STREAMS] = streams_obj;
        }
    }
    std::cout << "camera json: " << json::serialize(obj);
    return obj;
}

json::object UController::make_pipeline_json(const FPipelineData& data, const std::vector<std::string>& fields) {
    json::object obj;

    // Все пишем, если путой вектор
    if (fields.empty()) {
        for (const auto& [key, writer] : m_pipeline_field_map) {
            writer(data, obj);
        }
        return obj;
    }

    for (const auto& field : fields) {
        auto it = m_pipeline_field_map.find(field);
        if (it != m_pipeline_field_map.end()) {
            it->second(data, obj);
        }
    }
    std::cout << "pipeline json: " << json::serialize(obj) << std::endl;
    return obj;
}

boost::json::object UController::create_answer_message(
    const std::optional<boost::json::object>& data,
    const std::optional<boost::json::object>& meta,
    const std::optional<boost::json::object>& error) 
{
    boost::json::object result;

    result["data"] = data.has_value() ? *data : boost::json::value(nullptr);
    result["meta"] = meta.has_value() ? *meta : boost::json::value(nullptr);
    result["error"] = error.has_value() ? *error : boost::json::value(nullptr);



    return result;
}