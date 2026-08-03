#pragma once
#include <boost/json.hpp>

#include <cerrno>
#include <cstring>
#include <iostream>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <system_error>
#include <vector>

#include <fcntl.h>
#include <unistd.h>

#include "logger.h"
#include "utility/data-structs.h"
#include "utility/json-utils.h"
#include "constants.h"

namespace varan {
namespace nvr {

    namespace json = boost::json;

    struct FCameraConfiguration {
        FCameraData camera;
        std::map<std::string, FPipelineConfig> streams;
    };

    class UCameraConfigirationManager {
    public:
        explicit UCameraConfigirationManager(std::filesystem::path config_path, ULogger* logger)
            : m_path(std::move(config_path))
            , m_logger(logger)
        {}

        bool load() {
            std::lock_guard<std::mutex> lock(m_mutex);

            if (!std::filesystem::exists(m_path)) {
                // Громко: отсюда начинается «пустой конфиг», и если это не первый
                // запуск устройства — значит, смотрим не в тот varan-root
                if (m_logger) m_logger->warn("load(): " + m_path.string()
                    + " does not exist, creating EMPTY configuration from scratch");

                m_root = {
                    {"cameras", json::array()}
                };

                return save_internal();
            }

            std::ifstream file(m_path);

            if (!file.is_open()) {
                return false;
            }

            std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
            file.close();

            boost::system::error_code ec;

            auto parsed = json::parse(content, ec);

            if (ec || !parsed.is_object()) {
                /*
                    Битый файл откладывается в сторону, а не блокирует менеджер:
                    раньше m_root оставался пустым и каждый последующий
                    add_or_update_camera молча падал исключением — камеры
                    работали, но не сохранялись до ручного удаления файла.
                */
                const std::filesystem::path corrupt = m_path.string() + ".corrupt";
                std::error_code fs_ec;
                std::filesystem::rename(m_path, corrupt, fs_ec);

                if (m_logger) m_logger->error("load(): cannot parse " + m_path.string()
                    + (ec ? " (" + ec.message() + ")" : "")
                    + ", broken file moved to " + corrupt.string()
                    + ", starting with EMPTY configuration");

                m_root = {
                    {"cameras", json::array()}
                };

                return save_internal();
            }

            m_root = parsed.as_object();

            if (!m_root.contains("cameras")) {
                m_root["cameras"] = json::array();
            }

            return true;
        }

        bool save(const std::vector<FCameraStreamsData>& data) {
            std::lock_guard<std::mutex> lock(m_mutex);

            try {
                json::array cameras;
                for (const auto& config : data) {
                    cameras.push_back(serialize_camera_config(config));
                }

                m_root["cameras"] = std::move(cameras);

                return save_internal();
            }
            catch (const std::exception& error) {
                if (m_logger) m_logger->error("save(): throw exception: " + std::string(error.what()));
                return false;
            }
        }

        std::vector<FCameraConfiguration> get_all_configs() const {
            std::lock_guard<std::mutex> lock(m_mutex);

            std::vector<FCameraConfiguration> result;

            if (!m_root.contains("cameras")) {
                if (m_logger) m_logger->error("No field <cameras> at json!");
                return result;
            }

            const auto* cameras = m_root.if_contains("cameras");

            if (!cameras || !cameras->is_array()) {
                if (m_logger) m_logger->error("No field <cameras> at json!");
                return result;
            }

            for (const auto& item : cameras->as_array()) {
                if (!item.is_object()) {
                    continue;
                }

                try {
                    result.push_back(parse_camera_config(item.as_object()));
                }
                catch (const std::exception& error) {
                    if (m_logger) m_logger->error("Fail to get configurations: " + std::string(error.what()));
                    continue;
                }
            }

            return result;
        }

        std::optional<FCameraConfiguration> get_camera_config(const std::string& camera_id) const {
            std::lock_guard<std::mutex> lock(m_mutex);

            const auto& cameras = m_root.at("cameras").as_array();

            try {
                for (const auto& item : cameras) {
                    const auto& obj = item.as_object();

                    const auto& camera_obj = obj.at("camera").as_object();

                    if (json::value_to<std::string>(camera_obj.at("id")) == camera_id) {
                        return parse_camera_config(obj);
                    }
                }
            }
            catch (const std::exception& error) {
                if (m_logger) m_logger->error("get_camera_config(): throw exception: " + std::string(error.what()));
            }

            return std::nullopt;

        }

        bool add_or_update_camera(const FCameraStreamsData& data) {
            std::lock_guard<std::mutex> lock(m_mutex);

            try {
                auto& cameras = m_root["cameras"].as_array();

                for (auto& item : cameras) {
                    auto& obj = item.as_object();

                    auto& camera_obj = obj["camera"].as_object();
                    const auto id = json::value_to<std::string>(camera_obj["id"]);

                    if (id == data.camera.id) {
                        item = serialize_camera_config(data);

                        return save_internal();
                    }
                }

                cameras.push_back(serialize_camera_config(data));
                if (m_logger) m_logger->info("add_or_update_camera(): successfully created or updated camera " + std::string(data.camera.id));
                return save_internal();
            }
            catch (const std::exception& error) {
                if (m_logger) m_logger->error("add_or_update_camera(): throw exception: " + std::string(error.what()));
                return false;
            }
        }

        bool remove_camera(const std::string& camera_id) {
            std::lock_guard<std::mutex> lock(m_mutex);

            try {
                auto& cameras = m_root["cameras"].as_array();

                for (auto it = cameras.begin(); it != cameras.end(); ++it) {
                    auto& obj = it->as_object();

                    auto& camera_obj = obj["camera"].as_object();

                    const auto id = json::value_to<std::string>(camera_obj["id"]);

                    if (id == camera_id) {
                        cameras.erase(it);

                        return save_internal();
                    }
                }
            }
            catch (const std::exception& error) {
                if (m_logger) m_logger->error("remove_camera(): throw exception: " + std::string(error.what()));
                return false;
            }

            if (m_logger) m_logger->error("remove_camera(): camera with id=" + camera_id + " doesn't exist!");
            return false;
        }

        bool update_stream(const std::string& camera_id, const std::string& stream_name, const FPipelineData& pipeline) {
            std::lock_guard<std::mutex> lock(m_mutex);

            try {
                auto& cameras = m_root["cameras"].as_array();

                for (auto& item : cameras) {
                    auto& obj = item.as_object();

                    auto& camera_obj = obj["camera"].as_object();
                    const auto id = json::value_to<std::string>(camera_obj["id"]);

                    if (id != camera_id) {
                        continue;
                    }

                    auto& streams = obj["streams"].as_object();

                    streams[stream_name] = serialize_pipeline(pipeline);

                    return save_internal();
                }
            }
            catch (const std::exception& error) {
                if (m_logger) m_logger->error("update_stream(): throw exception: " + std::string(error.what()));
                return false;
            }

            if (m_logger) m_logger->error("update_stream(): stream at camera " + camera_id + " with stream=" + stream_name + " doesn't exist!");
            return false;
        }

    private:
        // reason — причина отказа; без неё в логе было «cannot be created» без errno
        bool ensure_parent_directory_exists(const std::filesystem::path& path, std::string& reason) const {
            std::error_code ec;

            const auto parent = path.parent_path();

            if (parent.empty()) {
                return true;
            }

            if (std::filesystem::exists(parent, ec)) {
                return true;
            }

            if (std::filesystem::create_directories(parent, ec)) {
                return true;
            }

            reason = ec ? ec.message() : "unknown error";
            return false;
        }

        bool save_internal() {
            if (m_logger) m_logger->info("Saving new configuration json to " + m_path.string());

            std::string reason;
            if (!ensure_parent_directory_exists(m_path, reason)) {
                if (m_logger) m_logger->error("Path " + m_path.string()
                    + " cannot be created (" + reason + "), false to save configuration file!");
                return false;
            }
            // Делаем слхранение файла в temp файл
            std::filesystem::path temp_path = m_path.string() + ".tmp";

            std::ostringstream oss;
            pretty_print(oss, m_root);
            const std::string payload = oss.str();

            /*
                Запись через open/write/fsync: без fsync при обесточивании rename
                переживает перезагрузку, а данные — нет, и файл откатывается к
                прежнему содержимому. Ровно так «обнулялись» камеры при
                выключении борта вскоре после сохранения.
            */
            const int fd = ::open(temp_path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
            if (fd < 0) {
                if (m_logger) m_logger->error("Error open file at " + temp_path.string()
                    + ": " + std::strerror(errno));
                return false;
            }

            std::size_t written = 0;
            while (written < payload.size()) {
                const ssize_t n = ::write(fd, payload.data() + written, payload.size() - written);
                if (n < 0) {
                    if (errno == EINTR) continue;
                    if (m_logger) m_logger->error("Error writing " + temp_path.string()
                        + ": " + std::strerror(errno));
                    ::close(fd);
                    return false;
                }
                written += static_cast<std::size_t>(n);
            }

            if (::fsync(fd) != 0) {
                if (m_logger) m_logger->error("fsync failed for " + temp_path.string()
                    + ": " + std::strerror(errno));
                ::close(fd);
                return false;
            }
            ::close(fd);

            // Переименовываем
            std::error_code ec;
            std::filesystem::rename(temp_path, m_path, ec);
            if (ec) {
                if (m_logger) m_logger->error("Error renaming " + temp_path.string()
                    + " -> " + m_path.string() + ": " + ec.message());
                return false;
            }

            // fsync каталога фиксирует сам rename на диске
            const auto parent = m_path.parent_path();
            const int dir_fd = ::open(parent.empty() ? "." : parent.c_str(), O_RDONLY | O_DIRECTORY);
            if (dir_fd >= 0) {
                ::fsync(dir_fd);
                ::close(dir_fd);
            }

            if (m_logger) m_logger->info("Successfully saved new configurations to file!");
            return true;
        }

        static json::object serialize_camera(
            const FCameraData& camera
        ) {
            return {
                {"id", camera.id},
                {"display_name", camera.display_name},
                {"description", camera.description},
                {"ip_adress", camera.ip_adress},
                {"port", camera.port},
                {"user", camera.user},
                {"password", camera.password},
                {"type", static_cast<int>(camera.type)},
                {"production", static_cast<int>(camera.production)}
            };
        }

        static FCameraData parse_camera(const json::object& obj) {
            FCameraData camera;

            camera.id = json::value_to<std::string>(obj.at("id"));
            camera.display_name = json::value_to<std::string>(obj.at("display_name"));
            camera.description = json::value_to<std::string>(obj.at("description"));
            camera.ip_adress = json::value_to<std::string>(obj.at("ip_adress"));
            camera.port = json::value_to<std::string>(obj.at("port"));
            camera.user = json::value_to<std::string>(obj.at("user"));
            camera.password = json::value_to<std::string>(obj.at("password"));
            camera.type = static_cast<ECameraType>(json::value_to<int>(obj.at("type")));
            camera.production = static_cast<ERtspType>(json::value_to<int>(obj.at("production")));

            return camera;
        }

        static json::object serialize_pipeline(const FPipelineData& pipeline, int reconnect_delay = 10) {
            return {
                {"name", pipeline.name},
                {"camera_name", ""},
                {"rtsp_url", ""},
                {"stream", pipeline.sub},
                {"type", static_cast<int>(pipeline.type)},
                {"latency", pipeline.latency},
                {"use_udp", pipeline.use_udp},
                {"reconnect_delay", reconnect_delay},
                {"to_record", pipeline.to_record},
                {"record_path", pipeline.record_path},
                {"segment_length", pipeline.segment_length}
            };
        }

        static FPipelineConfig parse_pipeline(const json::object& obj) {
            FPipelineConfig pipeline;

            pipeline.name =json::value_to<std::string>(obj.at("name"));
            pipeline.camera_name = json::value_to<std::string>(obj.at("camera_name"));
            pipeline.rtsp_url =json::value_to<std::string>(obj.at("rtsp_url"));
            pipeline.stream =json::value_to<int>(obj.at("stream"));
            pipeline.type =static_cast<EPilelineType>(json::value_to<int>(obj.at("type")));
            pipeline.latency = json::value_to<int>(obj.at("latency"));
            pipeline.use_udp = json::value_to<bool>(obj.at("use_udp"));
            pipeline.reconnect_delay = json::value_to<int>(obj.at("reconnect_delay"));
            if (obj.contains("to_record")) {
                pipeline.to_record = json::value_to<bool>(obj.at("to_record"));
            } else {
                pipeline.to_record = false;
            }
            pipeline.record_path = json::value_to<std::string>(obj.at("record_path"));
            pipeline.segment_length = json::value_to<int>(obj.at("segment_length"));

            return pipeline;
        }

        static json::object serialize_camera_config(const FCameraStreamsData& data) {
            json::object streams_obj;

            for (const auto& [name, pipeline]: data.pipelines) {
                streams_obj[name] = serialize_pipeline(pipeline);
            }

            return {
                {"camera", serialize_camera(data.camera)},
                {"streams", std::move(streams_obj)}
            };
        }

        static FCameraConfiguration parse_camera_config(const json::object& obj) {
            FCameraConfiguration config;

            config.camera = parse_camera(obj.at("camera").as_object());
            const auto& streams = obj.at("streams").as_object();

            for (const auto& [key, value]: streams) {
                config.streams.emplace(key, parse_pipeline(value.as_object()));
            }

            return config;
        }

    private:
        std::filesystem::path m_path;

        json::object m_root;

        ULogger* m_logger;

        mutable std::mutex m_mutex;
    };

} // namespace nvr
} // namespace varan