#include "media_center.h"
#include "console_utility.h"

namespace varan {
namespace neural {

UMediaCenter::UMediaCenter(const FMediaSettings& settings)
    : m_threads_count(4)
    , m_camera_initialization(false)
    , m_settings(settings)
{
}

int UMediaCenter::add_camera(const FCameraOptions& options) {
    std::lock_guard<std::mutex> lk(m_mutex);
    if (m_cameras.count(options.name))
        return -1;

    auto cam = std::make_shared<UCamera>(options);
    m_cameras[options.name] = std::move(cam);
    return 0;
}

// Удалить камеру (остановить и убрать)
int UMediaCenter::remove_camera(const std::string& camera_unique) {
    std::lock_guard<std::mutex> lk(m_mutex);
    auto it = m_cameras.find(camera_unique);
    if (it != m_cameras.end()) {
        it->second->stop();
        m_cameras.erase(it);
    }
    return 0;
}

std::vector<std::shared_ptr<UCamera>> UMediaCenter::get_camera_vector() {
    std::vector<std::shared_ptr<UCamera>> out;
    out.reserve(m_cameras.size());

    for (auto& [name, cam] : m_cameras) {
        out.push_back(cam);
    }

    return out;
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
                initialized = camera.second->create_gst_pipeline_webrtc();
            }
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

} // namespace neural
} // namespace varan