#pragma once
#include <opencv2/opencv.hpp>
#include <memory>
#include <atomic>
#include <thread>
#include <condition_variable>
#include <filesystem>

#include "bird-view/egl-context.h"
#include "utility/frame-storage.h"
#include "core/image-handler.h"

#include "neural/json-configurator.h"
#include "neural/classifier.h"

#include "logger.h"
#include "camera.h"

namespace varan {
namespace neural {

	class UNeuralLoader : public UImageHandler {
	public:
		struct FNeuralExports {
			std::string id;
			std::string name;
		};

		// Стратегия добавления новой конфигурации
		enum class EImportMode {
			MERGE,        // дописать/перезаписать конкретный id
			REPLACE_ALL,  // заменить весь файл конфигураций
		};

	public:
		UNeuralLoader() = delete;
		UNeuralLoader(
			const std::string& ip_address,
			const std::string& port,
			birdview::UEGLContextManager* context,
			FFrameStorage<IFrame>* storage,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
		);

		~UNeuralLoader();

		bool async_run();
		void stop_async_run();
		bool restart();
		bool is_running() const;

		std::vector<FNeuralExports> list_configurations() const;
		bool import_configurations(const boost::json::value& json, EImportMode mode);

		bool write_state(const std::string& config_id, const std::string& camera_id);
		boost::json::object get_state_raw() const;
		bool reload_from_state();

		std::string get_active_config_id() const;
		std::string get_active_camera_id() const;

	protected:
		virtual void internal_handle_image(cv::Mat rgb_pixels) override;

	private:
		bool start_loader();
		bool start_streaming(int width, int height);
		bool ensure_classifier();
		void handle_image_for_push(cv::Mat image);

		void supervisor_loop();
		void cleanup_after_failure();

		bool load_state();

	private:
		UJsonNeuralConfiguration m_json_configurator;
		FConfigInfo m_active_config;
		std::string m_active_config_id;
		std::string m_active_camera_id;

		std::unique_ptr<Classifier> m_classifier;
		std::unique_ptr<neural::UVirtualCamera> m_streamer;

		mutable std::mutex m_loader_mutex;

		std::thread m_supervisor;
		std::atomic<bool> m_supervisor_running{ false };
		std::mutex m_supervisor_cv_mutex;
		std::condition_variable m_supervisor_cv;

		std::string m_ip;
		std::string m_port;
		std::filesystem::path m_config_path;
		std::filesystem::path m_state_path;
	};

} // namespace neural
} // namespace varan