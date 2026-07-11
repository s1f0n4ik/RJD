#pragma once

#include <opencv2/opencv.hpp>
#include <memory>
#include <atomic>
#include <thread>
#include <condition_variable>
#include <filesystem>
#include <vector>

#include <boost/json.hpp>

#include "bird-view/egl-context.h"
#include "utility/frame-storage.h"

#include "neural/json-configurator.h"
#include "neural/slot.h"
#include "neural/matrix.h"
#include "core/platform.h"

#include "logger.h"
#include "camera.h"

#include <functional>

namespace varan {
namespace neural {

	class UNeuralLoader {
	public:
		
		enum class EImportMode {
			MERGE,
			REPLACE_ALL,
		};

		using FCameraSenderProvider = std::function<FCameraMessageSender(const std::string& camera_id)>;

	public:
		UNeuralLoader() = delete;
		UNeuralLoader(
			const std::string& ip_address,
			const std::string& port,
			birdview::UEGLContextManager* context,
			FFrameStorage<IFrame>* storage,
			std::filesystem::path config_path,
			std::filesystem::path state_path,
			FPlatformInfo platform,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
		);

		~UNeuralLoader();

		bool async_run();
		void stop_async_run();
		bool restart();
		bool is_running() const;

		// Конфигурации
		std::vector<FNeuralExports> list_configurations() const;
		// Полный JSON конкретного конфига (для GET ?id=...).
		boost::json::value get_configuration_full(const std::string& id) const;
		bool import_configurations(const boost::json::value& json, EImportMode mode);

		// State
		bool write_state(const std::vector<FNeuralCoreConfig>& active);
		boost::json::object get_state_raw() const;
		bool reload_from_state();

		void set_sender_provider(FCameraSenderProvider provider);

		// Геттеры
		std::vector<FNeuralCoreConfig> get_active_descriptors() const;
		struct FSlotStatus {
			std::string config_id;
			FCameraMatrix cameras;
			FCameraLayout camera_layout;
			std::string stream_id;
			bool running = false;
			std::vector<int> npu_cores;
		};
		std::vector<FSlotStatus> get_slots() const;

		std::optional<std::string> find_camera_config(const std::string& camera_id) const;

		const FPlatformInfo& platform() const { return m_platform; }

	private:
		bool start_loader();
		void cleanup_after_failure();
		void supervisor_loop();
		bool load_state();

		static FCameraMatrix parse_camera_matrix(const boost::json::value& v);
		static boost::json::array serialize_camera_matrix(const FCameraMatrix& m);
		bool validate_no_core_conflicts(const std::vector<FNeuralCoreConfig>& descs,
			std::string& err) const;
		std::string make_stream_id(const std::string& config_id, const std::string& camera_id) const;

	private:
		UJsonNeuralConfiguration m_json_configurator;
		std::vector<FNeuralCoreConfig> m_active_descs;
		std::vector<std::unique_ptr<USlot>> m_slots;

		mutable std::mutex m_loader_mutex;
		std::thread m_supervisor;
		std::atomic<bool> m_supervisor_running{ false };
		std::mutex m_supervisor_cv_mutex;
		std::condition_variable m_supervisor_cv;

		std::string m_ip;
		std::string m_port;
		birdview::UEGLContextManager* m_context;
		FFrameStorage<IFrame>* m_storage;
		ULogger::ELoggerLevel m_level;
		std::filesystem::path m_config_path;
		std::filesystem::path m_state_path;
		FPlatformInfo m_platform;
		ULogger m_logger;

		FCameraSenderProvider m_sender_provider;
	};

} // namespace neural
} // namespace varan