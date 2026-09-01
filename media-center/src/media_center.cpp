#include "media_center.h"

#include <algorithm>

#include "correction-extension.h"
#include "core/paths.h"
#include "console_utility.h"

namespace varan {
namespace neural {

    // Конфиг -> данные для записи: до старта камер живых данных ещё нет
    static FCameraStreamsData config_to_streams_data(const FCameraConfiguration& config) {
        FCameraStreamsData data;
        data.camera = config.camera;

        for (const auto& [name, pipeline] : config.streams) {
            FPipelineData stream{};

            stream.name = name;
            stream.status = EPipelineStatus::NONE;
            stream.type = EPilelineType::CAMERA;
            stream.purposes = pipeline.purposes;

            stream.width = 0;
            stream.height = 0;
            stream.fps = 0;

            stream.use_udp = pipeline.use_udp;
            stream.latency = pipeline.latency;
            stream.reconnect_time = pipeline.reconnect_delay;

            stream.record_path = pipeline.record_path.string();
            stream.segment_length = pipeline.segment_length;

            stream.channel = pipeline.channel;
            stream.substream = pipeline.substream;

            data.pipelines.emplace(name, std::move(stream));
        }

        return data;
    }

    UMediaCenter::UMediaCenter(const FWebSocketOptions& socket, birdview::UEGLContextManager* manager)
        : m_threads_count(4)
        , m_camera_initialization(false)
        , m_websocket(socket)
        , m_gl_manager(manager)
        , m_logger("Media Center", ULogger::ELoggerLevel::TRACE)
        , m_config_manager(varan::paths().nvr.config, &m_logger)
    {}

    void UMediaCenter::set_frame_storage(FFrameStorage<IFrame>* storage) {
        m_frame_storage = storage;
    }

    std::shared_ptr<UCamera> UMediaCenter::make_camera(
        const FCameraData& options,
        const std::map<std::string, FPipelineConfig>& pipelines
    ) {
        auto camera = std::make_shared<UCamera>(options.id, m_websocket);

        const bool has_birdview = std::any_of(pipelines.begin(), pipelines.end(),
            [](const auto& item) { return item.second.purposes.birdview; });

        // Коррекция дисторсии — надстройка модуля 360, а не свойство камеры
        if (has_birdview && m_frame_storage) {
            auto* raw = camera.get();

            auto reply = [raw](const std::string& client_id, bool ok, const std::string& type,
                               const std::string& description, int code) {
                raw->send_message(boost::json::serialize(
                    raw->make_json_message(client_id, ok, type, description, code)));
            };

            auto send = [raw](std::string message) {
                raw->send_message(std::move(message));
            };

            camera->add_extension(std::make_unique<UCorrectionExtension>(
                options.id,
                m_frame_storage,
                m_gl_manager,
                std::move(reply),
                std::move(send)
            ));
        }

        return camera;
    }

    int UMediaCenter::add_camera(const FCameraData& options, const std::map<std::string, FPipelineConfig>& pipelines, bool to_save) {
        std::lock_guard<std::mutex> lk(m_mutex);
        if (m_cameras.count(options.id)) {
            m_logger.error("add_camera(): cannot add camera, camera with id=" + options.id + " already exists!");
            return -1;
        }

        if (const auto error = validate_streams(pipelines)) {
            m_logger.error("add_camera(): camera id=" + options.id + ": " + *error
                + " (loaded modules: " + m_modules.to_string() + ")");
            return -1;
        }

        auto cam = make_camera(options, pipelines);
        cam->set_configurations(options, pipelines, make_frame_resolver(), m_gl_manager);

        m_cameras[options.id] = std::move(cam);

        if (to_save) {
            if (!options.id.starts_with("__probe_")) {
                if (!m_config_manager.add_or_update_camera(m_cameras[options.id]->get_data())) {
                    m_logger.error("add_camera(): camera id=" + options.id
                        + " is running but was NOT saved to configurations file!");
                }
            }
        }

        return 0;
    }

    bool UMediaCenter::add_camera_async(const FCameraData& options, const std::map<std::string, FPipelineConfig>& pipelines, bool to_save) {
        std::lock_guard<std::mutex> lk(m_mutex);

        if (m_cameras.count(options.id)) {
            return false;
        }

        if (const auto error = validate_streams(pipelines)) {
            m_logger.error("add_camera_async(): camera id=" + options.id + ": " + *error
                + " (loaded modules: " + m_modules.to_string() + ")");
            return false;
        }

        auto camera = make_camera(options, pipelines);
        camera->set_configurations(options, pipelines, make_frame_resolver(), m_gl_manager);

        camera->start_async();
        m_cameras[options.id] = std::move(camera);

        // Временные probe-камеры в постоянный конфиг не пишем — как в add_camera
        if (to_save && !options.id.starts_with("__probe_")) {
            if (!m_config_manager.add_or_update_camera(m_cameras[options.id]->get_data())) {
                m_logger.error("add_camera_async(): camera id=" + options.id
                    + " is running but was NOT saved to configurations file!");
            }
        }

        return true;
    }

    bool UMediaCenter::update_camera(
        const std::string& id,
        const std::optional<FCameraData>& camera_options,
        const std::optional<std::map<std::string, FPipelineConfig>>& pipelines,
        bool to_save 
    ) {
        std::lock_guard<std::mutex> lk(m_mutex);

        auto it = m_cameras.find(id);
        if (it == m_cameras.end()) {
            return false;
        }
        auto& camera = it->second;

        // Обновление метаданных
        if (camera_options && !pipelines) {
            camera->update_metadata(camera_options.value().display_name, camera_options.value().description);
            if (to_save && !m_config_manager.add_or_update_camera(camera->get_data())) {
                m_logger.error("update_camera(): camera id=" + id
                    + " metadata updated but NOT saved to configurations file!");
            }
            m_logger.info("update_camera(): successfully updated camera metadata with id=" + id);
            return true;
        }
        else if (camera_options && pipelines) {
            if (const auto error = validate_streams(*pipelines)) {
                m_logger.error("update_camera(): camera id=" + id + ": " + *error
                    + " (loaded modules: " + m_modules.to_string() + ")");
                return false;
            }
            camera->stop();
            // Набор надстроек зависит от назначений — пересоздаём камеру целиком
            auto recreated = make_camera(*camera_options, *pipelines);
            recreated->set_configurations(*camera_options, *pipelines, make_frame_resolver(), m_gl_manager);
            recreated->start_async();
            it->second = std::move(recreated);
            if (to_save && !m_config_manager.add_or_update_camera(it->second->get_data())) {
                m_logger.error("update_camera(): camera id=" + id
                    + " streams updated but NOT saved to configurations file!");
            }
            m_logger.info("update_camera(): successfully updated camera streams with id=" + id);
            return true;
        }
        else {
            m_logger.error("update_camera(): camera_options are null, cannot update the camera witg id=" + id);
            return false;
        }
    }

    // Удалить камеру (остановить и убрать)
    int UMediaCenter::remove_camera(const std::string& camera_unique, bool to_save) {
        std::lock_guard<std::mutex> lk(m_mutex);
        auto it = m_cameras.find(camera_unique);
        if (it != m_cameras.end()) {
            std::string camera_id = it->second->get_name();
            it->second->stop();
            m_cameras.erase(it);
            // Пробные камеры в конфигурацию не писались
            if (to_save && !camera_id.starts_with("__probe_")) {
                m_config_manager.remove_camera(camera_id);
            }
            m_logger.info("remove_camera(): successfully removed camera id=" + camera_id);
        }
        return 1;
    }

    void UMediaCenter::remove_camera_async(const std::string& camera_id, bool to_save) {
        // Вытаскиваем указатель на камеру
        std::shared_ptr<UCamera> camera_to_remove;
        {
            std::lock_guard<std::mutex> lk(m_mutex);
            auto it = m_cameras.find(camera_id);
            if (it == m_cameras.end()) {
                return;
            }

            camera_to_remove = std::move(it->second);
            m_cameras.erase(it);

            // Пробные камеры в конфигурацию не писались
            if (to_save && !camera_id.starts_with("__probe_")) {
                m_config_manager.remove_camera(camera_id);
            }
        }
        // Удаление в потоках камеры
        {
            std::lock_guard<std::mutex> lk(m_cleanup_mutex);

            // Чистим завершённые потоки
            m_cleanup_threads.erase(
                std::remove_if(m_cleanup_threads.begin(), m_cleanup_threads.end(),
                    [](std::thread& t) {
                        return !t.joinable();
                    }
                ),
                m_cleanup_threads.end()
            );

            m_cleanup_threads.emplace_back(
                [camera = std::move(camera_to_remove)]() mutable {
                    camera->stop();
                    camera.reset();
                }
            );
        }
    }

    void UMediaCenter::run_eos() {
        m_logger.warn("run_eos(): request exit!");
        for (const auto& [name, camera] : m_cameras) {
            camera->stop();
        }
        m_cameras.clear();
    }

    bool UMediaCenter::camera_exists(std::string name) {
        return m_cameras.find(name) == m_cameras.end() ? false : true;
    }

    std::shared_ptr<UCamera> UMediaCenter::get_camera(const std::string& id) {
        auto result = m_cameras.find(id);
        if (result == m_cameras.end()) {
            return nullptr;
        }
        return result->second;
    }

    void UMediaCenter::start_cameras_from_config() {
        if (!m_config_manager.load()) {
            m_logger.error("start_cameras_from_config(): failed to load configurations");
            return;
        }

        auto cameras = m_config_manager.get_all_configs();

        // Старый формат переписывается до старта камер
        if (m_config_manager.needs_rewrite()) {
            std::vector<FCameraStreamsData> migrated;
            migrated.reserve(cameras.size());

            for (const auto& camera : cameras) {
                migrated.push_back(config_to_streams_data(camera));
            }

            if (m_config_manager.save(migrated)) {
                m_config_manager.mark_rewritten();
                m_logger.info("start_cameras_from_config(): configuration migrated to the stream purposes format");
            }
            else {
                m_logger.error("start_cameras_from_config(): cannot rewrite migrated configuration");
            }
        }

        // Камеры с чужими назначениями пропускаются молча для фронта: только лог
        size_t skipped = 0;
        {
            for (const auto& camera : cameras) {
                if (const auto error = validate_streams(camera.streams)) {
                    m_logger.warn("start_cameras_from_config(): skip camera id=" + camera.camera.id
                        + ": " + *error + " (loaded modules: " + m_modules.to_string() + ")");
                    ++skipped;
                    continue;
                }
                add_camera(camera.camera, camera.streams);
            }
        }

        // Инициализация и ретраи живут в worker самой камеры, как при POST /camera
        size_t started = 0;
        {
            std::lock_guard<std::mutex> lk(m_mutex);
            for (auto& [id, cam] : m_cameras) {
                cam->start_async();
                ++started;
            }
        }

        m_camera_initialization = true;
        m_logger.info("start_cameras_from_config(): started "
            + std::to_string(started) + " cameras"
            + (skipped ? ", skipped " + std::to_string(skipped) + " (module not loaded)" : ""));
    }

    void UMediaCenter::initialize_cameras() {
        // Первичная инициализация камер
        size_t cameras_ready = 0;
        size_t camera_nums = m_cameras.size();
        std::cout << color::green << "[Media Center] Start to initializing cameras" << color::reset << std::endl;
        while (cameras_ready != camera_nums) {
            for (const auto& camera : m_cameras) {
                bool initialized = camera.second->initialize();
                if (initialized) {
                    cameras_ready++;
                }
            }
            if (cameras_ready == camera_nums) {
                m_camera_initialization = true;
                std::cout << color::green << "[Media Center] All cameras was initialized!" << color::reset << std::endl;
            }
            else {
                std::cout << color::red << "[Media Center] Error with initializing! Restart!" << color::reset << std::endl;
                cameras_ready = 0;
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            }
        }
    }


    void UMediaCenter::start_cameras() {
        if (m_camera_initialization == false) {
            std::cout << color::red << "[Media Center] Cannot start cameras without initialization!" << color::red << std::endl;
            return;
        }

        // Запуск камера и передача callback для забора кадров в буфер отображения
        std::lock_guard<std::mutex> lk(m_mutex);
        for (auto& [name, camera] : m_cameras) {
            /*
            camera->set_frame_callback(
                [this](std::string name, std::unique_ptr<FDrmFrame> frame) {
                    this->on_frame_received(name, std::move(frame));
                }
            );*/
            camera->start();
        }
        std::cout << color::yellow << "[Media Center] All camera streams are running!" << color::reset << std::endl;

        std::vector<FCameraStreamsData> data_vector;
        for (auto& [name, camera] : m_cameras) {
            data_vector.push_back(camera->get_data());
        }
        m_config_manager.save(data_vector);
    }

    void UMediaCenter::stop_cameras() {
        if (m_camera_initialization == false) {
            std::cout << color::red << "[Media Center] Cannot stop cameras without initialization!" << color::red << std::endl;
            return;
        }

        std::lock_guard<std::mutex> lk(m_mutex);
        for (auto& [id, cam] : m_cameras) {
            cam->stop();
        }
    }

    std::vector<FCameraStreamsData> UMediaCenter::get_cameras() {
        std::vector<FCameraStreamsData> data;
        for (const auto& [name, camera] : m_cameras) {
            data.push_back(camera->get_data());
        }
        return data;
    }

    CFrameMoverResolver UMediaCenter::make_frame_resolver() {
        return [this](const FStreamPurposes& purposes) -> CFrameMover {
            if (purposes.birdview) return m_bird_view_frame_mover;
            if (purposes.neural)   return m_neural_frame_mover;
            return nullptr;
        };
    }

    void UMediaCenter::set_modules(const FModuleSet& modules) {
        m_modules = modules;
    }

    std::optional<std::string> UMediaCenter::validate_streams(
        const std::map<std::string, FPipelineConfig>& pipelines
    ) const {
        if (pipelines.empty()) {
            return "Camera has no one pipeline!";
        }

        std::string neural_owner;
        std::string birdview_owner;

        for (const auto& [name, pipeline] : pipelines) {
            const auto& purposes = pipeline.purposes;

            if (purposes.empty()) {
                return "Pipeline " + name + ": doesn't set any purpose!";
            }

            if (const auto missing = m_modules.unsupported(purposes)) {
                const auto module_name = purpose_to_string(*missing);
                return "Pipeline " + name + ": purpose " + module_name
                    + " doesn't available — at this device has no module " + module_name;
            }

            // Ветка декода отдаёт кадры одному приёмнику
            if (purposes.neural && purposes.birdview) {
                return "Pipeline " + name + ": illegal to set both neural and birdview modules on the same pipeline";
            }

            // Потребители адресуют источник по камере, а не по потоку
            if (purposes.neural) {
                if (!neural_owner.empty()) {
                    return "Pipelines " + neural_owner + " and " + name
                        + ": purpose neural can set only one pipeline at the same camera!";
                }
                neural_owner = name;
            }

            if (purposes.birdview) {
                if (!birdview_owner.empty()) {
                    return "Pipeline " + birdview_owner + " and " + name
                        + ": purpose birdview can set only one pipeline at the same camera!";
                }
                birdview_owner = name;
            }

            if (purposes.record && (pipeline.record_path.empty() || pipeline.segment_length <= 0)) {
                return "Pipeline " + name + ": recording enabled, but didn't set record path or segment length";
            }
        }

        return std::nullopt;
    }

    void UMediaCenter::set_bird_view_callback(CFrameMover callback) {
        m_bird_view_frame_mover = std::move(callback);
    }

    void UMediaCenter::set_neural_callback(CFrameMover callback) {
        m_neural_frame_mover = std::move(callback);
    }

} // namespace neural
} // namespace varan