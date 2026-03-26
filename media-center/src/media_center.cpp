#include "media_center.h"
#include "console_utility.h"

namespace varan {
namespace neural {

UMediaCenter::UMediaCenter(const FWebSocketOptions& socket)
    : m_threads_count(4)
    , m_camera_initialization(false)
    , m_websocket(socket)
{
}

int UMediaCenter::add_camera(const FCameraData& options) {
    std::lock_guard<std::mutex> lk(m_mutex);
    if (m_cameras.count(options.name)) {
        return -1;
    }

    auto callback = get_frame_callback_by_camera_type(options.type);
    auto cam = std::make_shared<UCamera>(options, m_websocket, std::move(callback));

    m_cameras[options.name] = std::move(cam);
    return 0;
}

bool UMediaCenter::add_camera_async(const FCameraData& options) {
    std::lock_guard<std::mutex> lk(m_mutex);

    if (m_cameras.count(options.name)) {
        return false;
    }

    auto callback = get_frame_callback_by_camera_type(options.type);
    auto camera = std::make_shared<UCamera>(options, m_websocket, std::move(callback));

    camera->start_async();
    m_cameras[options.name] = std::move(camera);

    return true;
}

// Удалить камеру (остановить и убрать)
int UMediaCenter::remove_camera(const std::string& camera_unique) {
    std::lock_guard<std::mutex> lk(m_mutex);
    auto it = m_cameras.find(camera_unique);
    if (it != m_cameras.end()) {
        it->second->stop();
        m_cameras.erase(it);
    }
    return 1;
}

void UMediaCenter::remove_camera_async(const std::string& camera_name) {
    auto it = m_cameras.find(camera_name);
    if (it == m_cameras.end()) {
        return;
    }

    auto camera = std::move(it->second);
    m_cameras.erase(it);

    std::thread([cam = std::move(camera)]() mutable {
        cam->stop();
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

std::vector<FCameraData> UMediaCenter::get_cameras() {
    std::vector<FCameraData> data;
    for (const auto& [name, camera] : m_cameras) {
        data.push_back(camera->get_data());
    }
    return data;
}

CDmabufMover UMediaCenter::get_frame_callback_by_camera_type(ECameraType type) {
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

void UMediaCenter::set_bird_view_callback(CDmabufMover callback) {
    m_bird_view_frame_mover = std::move(callback);
}

void UMediaCenter::set_neural_callback(CDmabufMover callback) {
    m_neural_frame_mover = std::move(callback);
}

} // namespace neural
} // namespace varan