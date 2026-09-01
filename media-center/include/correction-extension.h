#pragma once

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "camera-extension.h"
#include "correction-pipeline.h"
#include "utility/frame-storage.h"
#include "logger.h"

namespace varan {
namespace neural {

	// Потомок - расширение для камеры, реализует дополнительный поток для коррекции изображения модулем 360
	class UCorrectionExtension : public ICameraExtension {
	public:
		inline static const std::string STREAM_KEY = "correction";

		UCorrectionExtension(
			std::string camera_id,
			FFrameStorage<IFrame>* storage,
			birdview::UEGLContextManager* gl_manager,
			CModuleReply reply,
			std::function<void(std::string)> send_callback,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
		);

		~UCorrectionExtension() override;

		std::string stream_key() const override { return STREAM_KEY; }

		bool handle_message(
			const std::string& client_id,
			const std::string& type,
			const boost::json::object& message
		) override;

		FStreamClaim select_stream(
			const std::string& client_id,
			const std::string& type,
			const boost::json::object& message
		) override;

		void on_session_closed(const std::string& client_id, UCameraPipeline* stream) override;

	private:

		// code — причина отказа: нет привязки калибровки или сборка не удалась
		bool build_correction_pipeline(std::string& error, int& code);

		// Разбор пайплайна уходит в поток GMainLoop; wait — дождаться конца
		void destroy_correction(bool wait);

		// Разбор конкретного пайплайна, в том числе недособранного
		void dispose_pipeline(std::unique_ptr<UCorrectionPipeline> victim, bool wait);

	private:
		std::string m_camera_id;

		FFrameStorage<IFrame>* m_storage = nullptr;
		birdview::UEGLContextManager* m_gl_manager = nullptr;

		CModuleReply m_reply;
		std::function<void(std::string)> m_send_callback;

		ULogger m_logger;

		std::unique_ptr<UCorrectionPipeline> m_correction;
		std::mutex m_correction_mutex;

		std::atomic<bool> m_correction_building{ false };
		std::thread m_correction_thread;
	};

} // namespace neural
} // namespace varan
