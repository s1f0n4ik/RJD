#include "main-server/controller.h"
#include <boost/json.hpp>
#include <sstream>
#include <unordered_set>

#include "utility/rtsp-url.h"
#include "utility/json-utils.h"

namespace http = boost::beast::http;
namespace json = boost::json;

using namespace varan::neural;
using namespace varan::nvr;
using namespace varan::rest;

UController::UController(std::shared_ptr<UMediaCenter> media_center)
    : m_media_center(media_center) {
}

// GET /camera?name=XXX
http::response<http::string_body>
UController::get_camera(const http::request<http::string_body>& req)
{
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
        std::vector<FCameraData> matched_data;

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
            for (const auto& camera : matched_data) {
                auto current = make_camera_json(camera, fields);
                if (!current.empty()) {
                    cameras[camera.name] = current;
                }
            }
            data[fields::CAMERAS] = cameras.empty() ? boost::json::value(nullptr) : cameras;
        }
        // Собираем итоговый
        body = create_answer_message(data, std::nullopt, std::nullopt);
        res.body() = json::serialize(body);
    }
    catch (const std::exception& e) {
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
        std::string name = obj[fields::NAME].as_string().c_str();
        if (m_media_center->camera_exists(name)) {
            throw std::runtime_error("Camera with name \"" + name + "\" already exists!");
        }
        // Создание ссылки на камеру

        auto prod = int_to_count_enum<ERtspType>(get_json_value<int64_t>(obj[fields::PRODUCTION], fields::PRODUCTION));
        if (prod == std::nullopt) {
            throw std::runtime_error("Not supported camera production!");
        }
        // Получение ссылки
        std::string ip_adress = get_json_value<std::string>(obj[fields::IP_ADRESS], fields::IP_ADRESS);
        std::string port = get_json_value<std::string>(obj[fields::PORT], fields::PORT);
        std::string user = get_json_value<std::string>(obj[fields::USER], fields::USER);
        std::string password = get_json_value<std::string>(obj[fields::PASSWORD], fields::PASSWORD);
        // Заполнение стурктуры;
        FCameraData camera_data;
        camera_data.name = name;
        camera_data.description = get_json_value<std::string>(obj[fields::DESCRIPTION], fields::DESCRIPTION);
        camera_data.ip_adress = ip_adress;
        camera_data.port = port;
        camera_data.user = user;
        // Тип камеры
        std::cout << json::serialize(obj) << std::endl;
        auto camera_type = int_to_count_enum<ECameraType>(get_json_value<int64_t>(obj[fields::TYPE], fields::TYPE));
        if (camera_type == std::nullopt) {
            throw std::runtime_error("Camera type doesn't supported!");
        }
        camera_data.type = camera_type.value();

        std::unordered_set<std::string> stream_names;
        // Парсинг объекта pipeline
        for (auto const& [name_stream, stream] : obj_streams) {
            if (!stream.is_object()) {
                throw std::runtime_error("Stream \"" + std::string(name_stream) + "\" is not json object!");
            }
            std::cout << name_stream << ": " << json::serialize(stream) << std::endl;
            auto stream_obj = stream.as_object();
            // Проверка полей стримов
            for (const auto& field : m_post_stream_fields) {
                if (!stream_obj.contains(field)) {
                    throw std::runtime_error("Stream \"" + std::string(name_stream) + "\" does not contain the required field <" + field + ">");
                }
            }
            // Проверка
            if (stream_names.contains(name_stream)) {
                throw std::runtime_error("This stream <" + std::string(name_stream) + "> name is already taken");
            } else {
                stream_names.insert(name_stream);
            }
            auto type_stream = int_to_count_enum<EPilelineType>(get_json_value<int64_t>(stream_obj[fields::TYPE], fields::TYPE));
            if (type_stream == std::nullopt) {
                throw std::runtime_error("Not supported stream type in \"" + std::string(name_stream) + "\"");
            }
            // Ссылка rtsp
            int sub = get_json_value<int64_t>(stream_obj[fields::SUB_STREAM], fields::SUB_STREAM);
            std::string rtsp = rtsp_maker.at(prod.value())(ip_adress, port, user, password, sub);
            // Заполнение структуры pipeline
            FPipelineData pipeline_data;
            pipeline_data.name = name_stream;
            pipeline_data.type = type_stream.value();
            pipeline_data.rtsp_url = rtsp;
            pipeline_data.latency = get_json_value<int64_t>(stream_obj[fields::LATENCY], fields::LATENCY);
            pipeline_data.use_udp = get_json_value<bool>(stream_obj[fields::USE_UDP], fields::USE_UDP);
            pipeline_data.reconnect_time = get_json_value<int64_t>(stream_obj[fields::RECONNECT], fields::RECONNECT);
            pipeline_data.record_path = get_json_value<std::string>(stream_obj[fields::RECORD_PATH], fields::RECORD_PATH);
            pipeline_data.segment_length = get_json_value<int64_t>(stream_obj[fields::SEGMENT_LENGTH], fields::SEGMENT_LENGTH);

            // Добавление структуры в камеру
            camera_data.pipelines[name_stream] = std::move(pipeline_data);
        }
        FWebSocketOptions websocket = FWebSocketOptions{"192.168.1.254", "8765"};
        if (m_media_center->add_camera_async(camera_data, websocket)) {
            body[fields::RESULT] = "success";
            body[fields::ERROR_DETAILS] = "Camera \"" + name + "\" successfully added to nvr!";

            res.body() = json::serialize(create_answer_message(body, std::nullopt, std::nullopt));
        }
        else {
            throw std::runtime_error("Camera \"" + name + "\" cannot be added");
        }

    }
    catch (const std::exception& e) {
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

// DELETE /camera?name=XXX
http::response<http::string_body>
UController::delete_camera(const http::request<http::string_body>& req) {
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
                if (field == fields::NAME) {
                    auto exists = m_media_center->camera_exists(value);
                    if (!exists) {
                        throw std::runtime_error("Camera with name " + value + " doesn't exist in nvr!");
                    }

                    m_media_center->remove_camera_async(value);

                    body[fields::RESULT] = "success";
                    body[fields::ERROR_DETAILS] = "Camera with name " + value + " successfully pended to delete!";
                    res.body() = json::serialize(create_answer_message(body, std::nullopt, std::nullopt));
                    break;
                }
            }
        }
    }
    catch (const std::exception& e) {
        res.result(http::status::bad_request);
        body[fields::ERROR_CODE] = 402;
        body[fields::ERROR_MESSAGE] = "Bad Request";
        body[fields::ERROR_DETAILS] = e.what();
        res.body() = json::serialize(create_answer_message(std::nullopt, std::nullopt, body));
    }

    res.prepare_payload();
    return res;
}

std::optional<FCameraData> UController::match_data_with_selectors(
    const std::unordered_map<std::string, std::string>& selectors, 
    FCameraData& data) 
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
                    else if (key_stream == fields::TYPE) counter += std::stoi(value) == static_cast<int>(stream.type);
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
            if (field == fields::NAME) camera_counts += value == data.name;
            else if (field == fields::DESCRIPTION) camera_counts += value == data.description;
        }
    }
    size_t previous_size = data.pipelines.size();
    FCameraData camera_data;

    size_t max_value = 0;
    for (const auto& [key, value] : stream_counts) {
        max_value = std::max(max_value, value);
    }

    if (camera_counts + max_value == selectors.size()) {
        camera_data.name = data.name;
        camera_data.description = data.description;
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

boost::json::object UController::make_camera_json(const FCameraData& data, const std::set<std::string>& fields) {
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