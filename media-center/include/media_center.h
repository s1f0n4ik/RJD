#include <unordered_map>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>
#include "bird-view/egl-context.h"
#include "core/modules.h"
#include "nvr/camera-configurator.h"
#include "utility/frame-storage.h"

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

	// Набор модулей сборки: назначения чужих модулей не обслуживаются
	void set_modules(const FModuleSet& modules);

	std::optional<std::string> validate_streams(
		const std::map<std::string, FPipelineConfig>& pipelines
	) const;

	// Хранилище кадров для потока коррекции камер с назначением 360
	void set_frame_storage(FFrameStorage<IFrame>* storage);

	// Индекс архивных сегментов; раздаётся камерам при их создании
	void set_segment_writer(std::shared_ptr<varan::archive::USegmentWriter> writer);

public:
	// Методы для серверной части
	std::vector<FCameraStreamsData> get_cameras();

	std::shared_ptr<UCamera> get_camera(const std::string& id);

private:
	// Кому идут кадры потока, решают его назначения
	CFrameMoverResolver make_frame_resolver();

	// Камера одна на все случаи; модульные надстройки вешаются по назначениям
	std::shared_ptr<UCamera> make_camera(
		const FCameraData& options,
		const std::map<std::string, FPipelineConfig>& pipelines
	);

private:
	UCameraConfigirationManager m_config_manager;

	FWebSocketOptions m_websocket;
	birdview::UEGLContextManager* m_gl_manager = nullptr;
	FModuleSet m_modules;

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

	FFrameStorage<IFrame>* m_frame_storage = nullptr;

	std::shared_ptr<varan::archive::USegmentWriter> m_segment_writer;

	// Потоки для удаления камер асинхронно
	std::mutex m_cleanup_mutex;
	std::vector<std::thread> m_cleanup_threads;

	ULogger m_logger;
};

} // neural
} // varan