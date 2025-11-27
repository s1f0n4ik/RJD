
#include <unordered_map>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>

#include "camera.h"

namespace varan {
namespace neural {

class UMediaCenter {
public:

	using FramePtr = std::unique_ptr<FDrmFrame>;

	UMediaCenter(int push_threads_count);

	int add_camera(const FCameraOptions& options);

	int remove_camera(const std::string& camera_name);

	//void print_status_line();

	void initialize_all();

	void start_all();

	void stop_all();

private:
	std::mutex m_mutex;
	std::mutex m_mutex_buffers;
	std::atomic<bool> m_running;

	std::unordered_map<std::string, std::unique_ptr<UCamera>> m_cameras;

	int m_threads_count;
	std::vector<std::thread> m_pushers_threads;

	bool m_camera_initialization;
};

} // neural
} // varan