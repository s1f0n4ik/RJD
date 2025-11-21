
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

	using FramePtr = std::shared_ptr<FDrmFrame>;

	UMediaCenter(int buffer_size);

	int add_camera(const FCameraOptions& options);

	int remove_camera(const std::string& camera_name);

	void print_status_line();

	void initialize_all();

	void start_all();

	void stop_all();

private:
	std::mutex m_mutex;
	std::mutex m_mutex_buffers;

	std::unordered_map<std::string, std::unique_ptr<UCamera>> m_cameras;

	int m_buffer_size;
	std::unordered_map<std::string, URingBuffer<FramePtr>> m_buffers;

	bool m_camera_initialization;

	void on_frame_received(const std::string& camera_name, std::unique_ptr<FDrmFrame> frame);

	URingBuffer<FramePtr>& get_buffer_for_camera(const std::string& camera_name);
};

} // neural
} // varan