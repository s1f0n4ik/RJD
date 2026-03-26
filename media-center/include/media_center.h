#include <unordered_map>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>

#include "camera.h"

using namespace varan::nvr;

namespace varan {
namespace neural {

class UMediaCenter {
public:

	UMediaCenter(const FWebSocketOptions& websocket);

	int add_camera(const FCameraData& options);

	bool add_camera_async(const FCameraData& options);

	int remove_camera(const std::string& camera_name);

	void remove_camera_async(const std::string& camera_name);

	bool camera_exists(std::string name);

	void initialize_cameras();

	void start_cameras();

	void stop_cameras();

	void run_eos();

	// Установка колбэеков
	void set_bird_view_callback(CDmabufMover callback);

	void set_neural_callback(CDmabufMover callback);

public:
	// Методы для серверной части
	std::vector<FCameraData> get_cameras();

private: 
	CDmabufMover get_frame_callback_by_camera_type(ECameraType type);

private:
	FWebSocketOptions m_websocket;

	std::mutex m_mutex;
	std::mutex m_mutex_buffers;
	std::atomic<bool> m_running;

	std::unordered_map<std::string, std::shared_ptr<UCamera>> m_cameras;

	int m_threads_count;
	std::vector<std::thread> m_pushers_threads;

	bool m_camera_initialization;

	// Колбэки для свящи с другими модулями
	CDmabufMover m_bird_view_frame_mover = nullptr;
	CDmabufMover m_neural_frame_mover = nullptr;
};

} // neural
} // varan