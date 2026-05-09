#include <unordered_map>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>
#include "bird-view/egl-context.h"
#include "nvr/camera-configurator.h"

#include "camera.h"

using namespace varan::nvr;

namespace varan {
namespace neural {

class UMediaCenter {
public:

	UMediaCenter(const FWebSocketOptions& websocket, birdview::UEGLContextManager* gl_manager = nullptr);

	int add_camera(const FCameraData& options, const std::map<std::string, FPipelineConfig>& pipelines, bool to_save = false);

	bool add_camera_async(const FCameraData& options, const std::map<std::string, FPipelineConfig>& pipelines, bool to_save = false);

	int remove_camera(const std::string& camera_name, bool to_save = false);

	void remove_camera_async(const std::string& camera_name, bool to_save = false);

	bool update_camera(
		const std::string& id,
		const std::optional<FCameraData>& camera_options,
		const std::optional<std::map<std::string, FPipelineConfig>>& pipelines,
		bool to_save = false
	);

	bool camera_exists(std::string name);

	void start_cameras_from_config();

	void initialize_cameras();

	void start_cameras();

	void stop_cameras();

	void run_eos();

	// Возвращает конфигуратор камер для сохранения параметров
	UCameraConfigirationManager* get_config_manager();

	// Установка колбэеков
	void set_bird_view_callback(CFrameMover callback);

	void set_neural_callback(CFrameMover callback);

public:
	// Методы для серверной части
	std::vector<FCameraStreamsData> get_cameras();

	std::shared_ptr<UCamera> get_camera(const std::string& id);

private: 
	CFrameMover get_frame_callback_by_camera_type(ECameraType type);

private:
	UCameraConfigirationManager m_config_manager;

	FWebSocketOptions m_websocket;
	birdview::UEGLContextManager* m_gl_manager = nullptr;

	std::mutex m_mutex;
	std::mutex m_mutex_buffers;
	std::atomic<bool> m_running;

	std::unordered_map<std::string, std::shared_ptr<UCamera>> m_cameras;

	int m_threads_count;
	std::vector<std::thread> m_pushers_threads;

	bool m_camera_initialization;

	// OpenGL контекст, если есть менеджер
	GstGLDisplay* m_gl_display = nullptr;
	GstGLContext* m_gl_context = nullptr;

	// Колбэки для свящи с другими модулями
	CFrameMover m_bird_view_frame_mover = nullptr;
	CFrameMover m_neural_frame_mover = nullptr;

	ULogger m_logger;
};

} // neural
} // varan