#pragma once
#include <opencv2/opencv.hpp>
#include <memory>
#include <atomic>
#include <thread>
#include <condition_variable>

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

	protected:
		virtual void internal_handle_image(cv::Mat rgb_pixels) override;

	private:
		bool start_loader();
		bool start_streaming(int width, int height);
		bool ensure_classifier();
		void handle_image_for_push(cv::Mat image);

		void supervisor_loop();
		void cleanup_after_failure();

	private:
		UJsonNeuralConfiguration m_json_configurator;
		FConfigInfo              m_active_config;

		std::unique_ptr<Classifier>             m_classifier;
		std::unique_ptr<neural::UVirtualCamera> m_streamer;

		std::mutex m_loader_mutex;

		std::thread             m_supervisor;
		std::atomic<bool>       m_supervisor_running{ false };
		std::mutex              m_supervisor_cv_mutex;
		std::condition_variable m_supervisor_cv;

		std::string m_ip;
		std::string m_port;
	};

} // namespace neural
} // namespace varan