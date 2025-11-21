#include "media_center.h"
#include "console_utility.h"

namespace varan {
namespace neural {

UMediaCenter::UMediaCenter(int buffer_size) 
    : m_buffer_size(buffer_size)
    , m_camera_initialization(false)
{
}

int UMediaCenter::add_camera(const FCameraOptions& options) {
    std::lock_guard<std::mutex> lk(m_mutex);
    if (m_cameras.count(options.name))
        return -1;

    auto cam = std::make_unique<UCamera>(options);
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
    m_buffers.erase(camera_unique);
    return 0;
}

void UMediaCenter::initialize_all() {
    size_t cameras_ready = 0;
    size_t camera_nums = m_cameras.size();
    std::cout << color::green << "[Media Center] Start to initializing cameras" << color::reset << std::endl;
    while (cameras_ready != camera_nums) {
        for (const auto& camera : m_cameras) {
            bool initialized = camera.second->initialize();
            if (initialized) {
                initialized = camera.second->create_gst_pipeline();
            }
            if (initialized) {
                cameras_ready++;
            }
        }
        if (cameras_ready == camera_nums) {
            m_camera_initialization = true;
            std::cout << color::green << "[Media Center] All cameras was initialized!" << color::reset << std::endl;
            return;
        }
        else {
            std::cout << color::red << "[Media Center] Error with initializing! Restart!" << color::reset << std::endl;
            cameras_ready = 0;
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
        }
    }
}


void UMediaCenter::start_all() {
    if (m_camera_initialization == false) {
        std::cout << color::red << "[Media Center] Cannot start cameras without initialization!" << color::red << std::endl;
        return;
    }

    // Запуск камера и передача callback для забора кадров в буфер отображения
    std::lock_guard<std::mutex> lk(m_mutex);
    for (auto& [name, camera] : m_cameras) {
        camera->set_frame_callback(
            [this](std::string name, std::unique_ptr<FDrmFrame> frame) {
                this->on_frame_received(name, std::move(frame));
            }
        );
        camera->start();
    }
    std::cout << color::yellow << "[Media Center] All camera streams are running!" << color::reset << std::endl;
}

void UMediaCenter::stop_all() {
    if (m_camera_initialization == false) {
        std::cout << color::red << "[Media Center] Cannot stop cameras without initialization!" << color::red << std::endl;
        return;
    }

    std::lock_guard<std::mutex> lk(m_mutex);
    for (auto& [id, cam] : m_cameras) {
        cam->stop();
    }
}

URingBuffer<UMediaCenter::FramePtr>& UMediaCenter::get_buffer_for_camera(const std::string& camera_name) {
    std::unique_lock lock(m_mutex_buffers);
    return m_buffers.try_emplace(camera_name, m_buffer_size).first->second;
}

void UMediaCenter::on_frame_received(const std::string& camera_name, std::unique_ptr<FDrmFrame> frame){
    FramePtr shared_frame = std::move(frame);

    auto& buffer = get_buffer_for_camera(camera_name);

    buffer.push(std::move(shared_frame));
}

void UMediaCenter::print_status_line() {
    std::lock_guard<std::mutex> lk(m_mutex);

    std::ostringstream ss;

    for (auto& [name, buf] : m_buffers) {
        auto last = buf.peek();
        if (last.has_value()) {
            const auto& frame = last.value().get();
            ss << name << " " << frame->pts_ms << " ";
        }
        else {
            ss << name << " <empty> ";
        }
    }

    std::string line = ss.str();
    std::cout << "\r" << line << std::string(40, ' ') << std::flush;
}

} // namespace neural
} // namespace varan