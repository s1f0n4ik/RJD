
#include <unordered_map>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>

#include "camera.h"

using namespace varan::nvr;

namespace varan {
namespace neural {

struct FMediaSettings {
	std::string ip_adress;
	int port;
};

class UMediaCenter {
public:

	using FramePtr = std::unique_ptr<FDrmFrame>;

	UMediaCenter(const FMediaSettings& settings);

	int add_camera(const FCameraData& options, const FWebSocketOptions& socket_options);

	bool add_camera_async(const FCameraData& options, const FWebSocketOptions& socket_options);

	int remove_camera(const std::string& camera_name);

	void remove_camera_async(const std::string& camera_name);

	bool camera_exists(std::string name);

	void initialize_cameras();

	void start_cameras();

	void stop_cameras();

public:
	// Методы для серверной части
	std::vector<FCameraData> get_cameras();

private:
	FMediaSettings m_settings;

	std::mutex m_mutex;
	std::mutex m_mutex_buffers;
	std::atomic<bool> m_running;

	std::unordered_map<std::string, std::shared_ptr<UCamera>> m_cameras;

	int m_threads_count;
	std::vector<std::thread> m_pushers_threads;

	bool m_camera_initialization;
};

} // neural
} // varan