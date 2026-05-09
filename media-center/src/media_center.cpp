#include "media_center.h"
#include "console_utility.h"

namespace varan {
namespace neural {

UMediaCenter::UMediaCenter(const FWebSocketOptions& socket, birdview::UEGLContextManager* manager)
    : m_threads_count(4)
    , m_camera_initialization(false)
    , m_websocket(socket)
    , m_gl_manager(manager)
    , m_logger("Media Center", ULogger::ELoggerLevel::TRACE)
    , m_config_manager(constants::CONFIG_PATH, &m_logger)
{}

int UMediaCenter::add_camera(const FCameraData& options, const std::map<std::string, FPipelineConfig>& pipelines, bool to_save) {
    std::lock_guard<std::mutex> lk(m_mutex);
    if (m_cameras.count(options.id)) {
        m_logger.error("add_camera(): cannot add camera, camera with id=" + options.id + " already exists!");
        return -1;
    }

    auto callback = get_frame_callback_by_camera_type(options.type);
    auto cam = std::make_shared<UCamera>(options.id, m_websocket);
    cam->set_configurations(options, pipelines, std::move(callback), m_gl_manager);

    m_cameras[options.id] = std::move(cam);

    if (to_save) m_config_manager.add_or_update_camera(m_cameras[options.id]->get_data());

    return 0;
}

bool UMediaCenter::add_camera_async(const FCameraData& options, const std::map<std::string, FPipelineConfig>& pipelines, bool to_save) {
    std::lock_guard<std::mutex> lk(m_mutex);

    if (m_cameras.count(options.id)) {
        return false;
    }

    auto callback = get_frame_callback_by_camera_type(options.type);
    auto camera = std::make_shared<UCamera>(options.id, m_websocket);
    camera->set_configurations(options, pipelines, std::move(callback), m_gl_manager);

    camera->start_async();
    m_cameras[options.id] = std::move(camera);

    if (to_save) m_config_manager.add_or_update_camera(m_cameras[options.id]->get_data());

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
        if (to_save) m_config_manager.add_or_update_camera(camera->get_data());
        m_logger.info("update_camera(): successfully updated camera metadata with id=" + id);
        return true;
    }
    else if (camera_options && pipelines) {
        camera->stop();
        auto callback = get_frame_callback_by_camera_type(camera_options.value().type);
        camera->set_configurations(*camera_options, *pipelines, std::move(callback), m_gl_manager);
        camera->start_async();
        if (to_save) m_config_manager.add_or_update_camera(camera->get_data());
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
        if (to_save) m_config_manager.remove_camera(camera_id);
        m_logger.info("remove_camera(): successfully removed camera id=" + camera_id);
    }
    return 1;
}

void UMediaCenter::remove_camera_async(const std::string& camera_id, bool to_save) {
    std::thread([this, camera_id, to_save]() {
        std::lock_guard<std::mutex> lk(m_mutex);

        auto it = m_cameras.find(camera_id);
        if (it == m_cameras.end()) {
            return;
        }

        m_cameras.erase(it);

        if (to_save) m_config_manager.remove_camera(camera_id);

    }).detach();
}

void UMediaCenter::run_eos() {
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
    int ready = 0;

    // Добавляем камеры в список
    for (const auto& camera : cameras) {
        add_camera(camera.camera, camera.streams);
    }

    // Начинаем инициализацию + асинхронный запуск
    int count = m_cameras.size();
    while (ready < count) {
        for (auto& camera : m_cameras) {
            if (camera.second->initialize()) {
                ready++;

                camera.second->start_async();
            }
            else {
                m_logger.error("start_cameras_from_config(): camera " + camera.second->get_name() + " didn't initialized!");
            }
        }
        if (ready != count) {
            ready = 0;
            m_logger.error((std::ostringstream() 
                << "start_cameras_from_config(): Initialized " << ready << " of " << count << " cameras at nvr. Restart!").str()
            );
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
        }
    }
    m_camera_initialization = true;
    m_logger.info("start_cameras_from_config():  All cameras was initialized!");
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

CFrameMover UMediaCenter::get_frame_callback_by_camera_type(ECameraType type) {
    switch (type) {
    case ECameraType::BIRDVIEW:
        return m_bird_view_frame_mover;
    case ECameraType::NEURAL:
        return m_neural_frame_mover;
    case ECameraType::GENERAL:
    case ECameraType::NONE:
    case ECameraType::COUNT:
    default:
        return nullptr;
    }
}

void UMediaCenter::set_bird_view_callback(CFrameMover callback) {
    m_bird_view_frame_mover = std::move(callback);
}

void UMediaCenter::set_neural_callback(CFrameMover callback) {
    m_neural_frame_mover = std::move(callback);
}

} // namespace neural
} // namespace varan