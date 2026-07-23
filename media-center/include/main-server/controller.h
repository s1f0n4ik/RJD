#pragma once

#include "media_center.h"
#include <boost/beast/http.hpp>
#include <memory>
#include <set>
#include <unordered_map>
#include <optional>

#include "utility/json-definers.h"
#include "logger.h"

using namespace varan::neural;
using namespace varan::rest;

class UController {
public:
    // Виртуальные потоки для ответа GET /camera, собирает их чужой контроллер
    using CVirtualStreamsProvider = std::function<boost::json::array()>;

public:
    explicit UController(std::shared_ptr<UMediaCenter> media_center, ULogger* logger = nullptr);

    void set_virtual_streams_provider(CVirtualStreamsProvider provider);

    boost::beast::http::response<boost::beast::http::string_body>
        get_camera(const boost::beast::http::request<boost::beast::http::string_body>& req);

    boost::beast::http::response<boost::beast::http::string_body>
        post_camera(const boost::beast::http::request<boost::beast::http::string_body>& req);

    boost::beast::http::response<boost::beast::http::string_body>
        patch_camera(const boost::beast::http::request<boost::beast::http::string_body>& req);

    boost::beast::http::response<boost::beast::http::string_body>
        delete_camera(const boost::beast::http::request<boost::beast::http::string_body>& req);

private:
    std::shared_ptr<UMediaCenter> m_media_center;
    ULogger* m_logger;
    CVirtualStreamsProvider m_virtual_streams;

    boost::json::object make_camera_json(const FCameraStreamsData& data, const std::set<std::string>& fields);

    boost::json::object make_pipeline_json(const FPipelineData& data, const std::vector<std::string>& fields);

    static boost::json::object create_answer_message(
        const std::optional<boost::json::object>& data, 
        const std::optional<boost::json::object>& meta,
        const std::optional<boost::json::object>& error);

    static std::optional<FCameraStreamsData> match_data_with_selectors(
        const std::unordered_map<std::string, std::string>& selectors, 
        FCameraStreamsData& data
    );

    static void parse_query(
        std::string_view query,
        std::unordered_map<std::string, std::string>& selections,
        std::set<std::string>& fields
    );

private:
    using CCameraFieldWriter = std::function<void(const FCameraStreamsData& data, boost::json::object& obj)>;
    using CStreamFieldWriter = std::function<void(const FPipelineData& data, boost::json::object& obj)>;
             
    const std::map<std::string, CCameraFieldWriter> m_camera_field_map = {
        { fields::DISPLAY_NAME, [](const FCameraStreamsData& data,  boost::json::object& obj) {
            obj[fields::DISPLAY_NAME] = data.camera.display_name;
        }},
        { fields::DESCRIPTION, [](const FCameraStreamsData& data,  boost::json::object& obj) {
            obj[fields::DESCRIPTION] = data.camera.description;
        }},
        { fields::IP_ADRESS, [](const FCameraStreamsData& data,  boost::json::object& obj) {
            obj[fields::IP_ADRESS] = data.camera.ip_adress;
        }},
        { fields::PORT, [](const FCameraStreamsData& data,  boost::json::object& obj) {
            obj[fields::PORT] = data.camera.port;
        }},
        { fields::USER, [](const FCameraStreamsData& data,  boost::json::object& obj) {
            obj[fields::USER] = data.camera.user;
        }},
        { fields::PASSWORD, [](const FCameraStreamsData& data,  boost::json::object& obj) {
            obj[fields::PASSWORD] = data.camera.password;
        }},
        { fields::CAMERA_TYPE, [](const FCameraStreamsData& data,  boost::json::object& obj) {
            obj[fields::CAMERA_TYPE] = static_cast<int>(data.camera.type);
        }},
        { fields::PRODUCTION, [](const FCameraStreamsData& data,  boost::json::object& obj) {
            obj[fields::PRODUCTION] = static_cast<int>(data.camera.production);
        }},
        { fields::STREAMS, [this](const FCameraStreamsData& data,  boost::json::object& obj) {
                boost::json::object arr;
                for (const auto& [name, pipe] : data.pipelines) {
                    std::vector<std::string> vec;
                    arr[name] = make_pipeline_json(pipe, vec);
                }
                if (!arr.empty()) {
                    obj[fields::STREAMS] = arr;
                }
            }
        }
    };

    const std::map<std::string, CStreamFieldWriter> m_pipeline_field_map = {
        { fields::TYPE, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::TYPE] = static_cast<int>(data.type);
        }},
        { fields::STATUS, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::STATUS] = static_cast<int>(data.status);
        }},
        { fields::WIDTH, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::WIDTH] = data.width;
        }},
        { fields::HEIGHT, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::HEIGHT] = data.height;
        }},
        { fields::CODEC, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::CODEC] = data.codec;
        }},
        { fields::FPS, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::FPS] = data.fps;
        }},
        { fields::USE_UDP, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::USE_UDP] = data.use_udp;
        }},
        { fields::RTSP_URL, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::RTSP_URL] = data.rtsp_url;
        }},
        { fields::LATENCY, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::LATENCY] = data.latency;
        }},
        { fields::TO_RECORD, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::TO_RECORD] = data.to_record;
        }},
        { fields::RECORD_PATH, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::RECORD_PATH] = data.record_path;
        }},
        { fields::SEGMENT_LENGTH, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::SEGMENT_LENGTH] = data.segment_length;
        }},
        { fields::RECONNECT, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::RECONNECT] = data.reconnect_time;
        }},
        { fields::SUB_STREAM, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::SUB_STREAM] = data.sub;
        }}
    };

    const std::vector<std::string> m_post_camera_fields = {
        fields::ID, fields::DISPLAY_NAME, fields::DESCRIPTION, fields::IP_ADRESS, fields::PORT, fields::TYPE, 
        fields::USER, fields::PASSWORD, fields::PRODUCTION, fields::STREAMS
    };

    const std::vector<std::string> m_post_stream_fields = {
        fields::SUB_STREAM, fields::LATENCY, fields::USE_UDP, fields::RECONNECT,
        fields::TO_RECORD, fields::RECORD_PATH, fields::SEGMENT_LENGTH, fields::TYPE
    };
};
