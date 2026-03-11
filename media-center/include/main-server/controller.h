#pragma once

#include "media_center.h"
#include <boost/beast/http.hpp>
#include <memory>
#include <set>
#include <unordered_map>
#include <optional>

#include "utility/json-definers.h"

using namespace varan::neural;
using namespace varan::rest;

class UController {
public:
    explicit UController(std::shared_ptr<UMediaCenter> media_center);

    boost::beast::http::response<boost::beast::http::string_body>
        get_camera(const boost::beast::http::request<boost::beast::http::string_body>& req);

    boost::beast::http::response<boost::beast::http::string_body>
        post_camera(const boost::beast::http::request<boost::beast::http::string_body>& req);

    boost::beast::http::response<boost::beast::http::string_body>
        delete_camera(const boost::beast::http::request<boost::beast::http::string_body>& req);

private:
    std::shared_ptr<UMediaCenter> m_media_center;

    boost::json::object make_camera_json(const FCameraData& data, const std::set<std::string>& fields);

    boost::json::object make_pipeline_json(const FPipelineData& data, const std::vector<std::string>& fields);

    static boost::json::object create_answer_message(
        const std::optional<boost::json::object>& data, 
        const std::optional<boost::json::object>& meta,
        const std::optional<boost::json::object>& error);

    static std::optional<FCameraData> match_data_with_selectors(
        const std::unordered_map<std::string, std::string>& selectors, 
        FCameraData& data
    );

    static void parse_query(
        std::string_view query,
        std::unordered_map<std::string, std::string>& selections,
        std::set<std::string>& fields
    );

private:
    using CCameraFieldWriter = std::function<void(const FCameraData& data, boost::json::object& obj)>;
    using CStreamFieldWriter = std::function<void(const FPipelineData& data, boost::json::object& obj)>;

    const std::map<std::string, CCameraFieldWriter> m_camera_field_map = {
        { fields::DESCRIPTION, [](const FCameraData& data,  boost::json::object& obj) {
            obj[fields::DESCRIPTION] = data.description;
        }},
        { fields::IP_ADRESS, [](const FCameraData& data,  boost::json::object& obj) {
            obj[fields::IP_ADRESS] = data.ip_adress;
        }},
        { fields::PORT, [](const FCameraData& data,  boost::json::object& obj) {
            obj[fields::PORT] = data.port;
        }},
        { fields::USER, [](const FCameraData& data,  boost::json::object& obj) {
            obj[fields::USER] = data.user;
        }},
        { fields::STREAMS, [this](const FCameraData& data,  boost::json::object& obj) {
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
        { fields::RECORD_PATH, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::RECORD_PATH] = data.record_path;
        }},
        { fields::SEGMENT_LENGTH, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::SEGMENT_LENGTH] = data.segment_length;
        }},
        { fields::RECONNECT, [](const FPipelineData& data, boost::json::object& obj) {
            obj[fields::RECONNECT] = data.reconnect_time;
        }}
    };

    const std::vector<std::string> m_post_camera_fields = {
        fields::NAME, fields::DESCRIPTION, fields::IP_ADRESS, fields::PORT, fields::TYPE, 
        fields::USER, fields::PASSWORD, fields::PRODUCTION, fields::STREAMS
    };

    const std::vector<std::string> m_post_stream_fields = {
        fields::SUB_STREAM, fields::LATENCY, fields::USE_UDP, fields::RECONNECT,
        fields::RECORD_PATH, fields::SEGMENT_LENGTH, fields::TYPE
    };
};
