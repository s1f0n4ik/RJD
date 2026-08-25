#pragma once
#include <boost/json.hpp>

#include <atomic>
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

        // Конфиг прочитан в старом формате и должен быть переписан до старта камер
        bool needs_rewrite() const { return m_legacy_seen.load(); }

        void mark_rewritten() { m_legacy_seen = false; }

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
                    bool legacy_seen = false;
                    result.push_back(parse_camera_config(item.as_object(), legacy_seen));

                    if (legacy_seen) {
                        m_legacy_seen = true;
                        if (m_logger) m_logger->warn("get_all_configs(): camera "
                            + result.back().camera.id + " read from the old format, configuration must be rewritten");
                    }
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
                        bool legacy_seen = false;
                        auto config = parse_camera_config(obj, legacy_seen);
                        if (legacy_seen) m_legacy_seen = true;
                        return config;
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
            camera.production = static_cast<ERtspType>(json::value_to<int>(obj.at("production")));

            return camera;
        }

        // Тип камеры из старого конфига: 2 — тех. зрение, 3 — камера 360
        static int legacy_camera_type(const json::object& obj) {
            const auto* type = obj.if_contains("type");
            return (type && type->is_int64()) ? json::value_to<int>(*type) : 0;
        }

        // main и sub — ключи из старого конфига
        static std::string migrate_stream_key(const std::string& key) {
            if (key == "main") return "stream_1";
            if (key == "sub")  return "stream_2";
            return key;
        }

        static json::object serialize_pipeline(const FPipelineData& pipeline) {
            json::array purposes;
            for (const auto& name : pipeline.purposes.names()) {
                purposes.push_back(json::string(name));
            }

            return {
                {"name", pipeline.name},
                {"channel", pipeline.channel},
                {"substream", pipeline.substream},
                {"purposes", std::move(purposes)},
                {"latency", pipeline.latency},
                {"use_udp", pipeline.use_udp},
                {"reconnect_delay", pipeline.reconnect_time},
                {"record_path", pipeline.record_path},
                {"segment_length", pipeline.segment_length}
            };
        }

        // Назначения потока из старого конфига
        static FStreamPurposes migrate_purposes(const json::object& obj, int camera_type) {
            FStreamPurposes purposes;

            const auto* type = obj.if_contains("type");
            const int stream_type = (type && type->is_int64()) ? json::value_to<int>(*type) : 1;

            if (stream_type == 2) {
                purposes.add(EStreamPurpose::VIEW);
                return purposes;
            }

            const auto* to_record = obj.if_contains("to_record");
            if (to_record && to_record->is_bool() && to_record->as_bool()) {
                purposes.add(EStreamPurpose::RECORD);
            }

            if (camera_type == 2) purposes.add(EStreamPurpose::NEURAL);
            if (camera_type == 3) purposes.add(EStreamPurpose::BIRDVIEW);

            // Поток без назначений недопустим
            if (purposes.empty()) purposes.add(EStreamPurpose::VIEW);

            return purposes;
        }

        static FPipelineConfig parse_pipeline(
            const json::object& obj,
            const std::string& name,
            int camera_type,
            bool& legacy_seen
        ) {
            FPipelineConfig pipeline;

            pipeline.name = name;
            pipeline.latency = json::value_to<int>(obj.at("latency"));
            pipeline.use_udp = json::value_to<bool>(obj.at("use_udp"));
            pipeline.reconnect_delay = json::value_to<int>(obj.at("reconnect_delay"));
            pipeline.record_path = json::value_to<std::string>(obj.at("record_path"));
            pipeline.segment_length = json::value_to<int>(obj.at("segment_length"));

            // В старом конфиге число было одно
            pipeline.channel = obj.contains("channel") ? json::value_to<int>(obj.at("channel")) : 1;

            if (obj.contains("substream")) {
                pipeline.substream = json::value_to<int>(obj.at("substream"));
            }
            else if (obj.contains("stream")) {
                pipeline.substream = json::value_to<int>(obj.at("stream"));
                legacy_seen = true;
            }

            const auto* purposes = obj.if_contains("purposes");
            if (purposes && purposes->is_array()) {
                for (const auto& item : purposes->as_array()) {
                    if (!item.is_string()) continue;
                    if (auto purpose = purpose_from_string(json::value_to<std::string>(item))) {
                        pipeline.purposes.add(*purpose);
                    }
                }
            }
            else {
                pipeline.purposes = migrate_purposes(obj, camera_type);
                legacy_seen = true;
            }

            // Путь и длина сегмента без записи не значат ничего
            if (!pipeline.purposes.record) {
                pipeline.record_path.clear();
                pipeline.segment_length = 0;
            }

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

        static FCameraConfiguration parse_camera_config(const json::object& obj, bool& legacy_seen) {
            FCameraConfiguration config;

            const auto& camera_obj = obj.at("camera").as_object();

            config.camera = parse_camera(camera_obj);

            const int camera_type = legacy_camera_type(camera_obj);
            if (camera_type != 0) legacy_seen = true;

            const auto& streams = obj.at("streams").as_object();

            for (const auto& [key, value]: streams) {
                const std::string name = migrate_stream_key(std::string(key));
                if (name != key) legacy_seen = true;

                config.streams.emplace(name, parse_pipeline(value.as_object(), name, camera_type, legacy_seen));
            }

            return config;
        }

    private:
        std::filesystem::path m_path;

        json::object m_root;

        ULogger* m_logger;

        mutable std::mutex m_mutex;

        mutable std::atomic<bool> m_legacy_seen{ false };
    };

} // namespace nvr
} // namespace varan