#pragma once
#include <thread>
#include <optional>
#include <functional>

#include <opencv2/opencv.hpp>

#include "utility/data-structs.h"
#include "utility/frames.h"
#include "utility/frame-storage.h"

#include "bird-view/egl-context.h"
#include "logger.h"

namespace varan {

	class UImageHandler {
	public:
		UImageHandler() = delete;
		UImageHandler(
			birdview::UEGLContextManager* context,
			FFrameStorage<IFrame>* storage,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::TRACE,
			std::optional<std::string> obj_name = std::nullopt
		);

		virtual ~UImageHandler();

		bool start_handler_thread(
			const std::string& slot_name,
			int fps = 15,
			std::function<void(const std::string& message)> send = nullptr
		);

		bool is_running();

		void stop_handler_thread(std::function<void(const std::string& message)> send = nullptr);

		// Смена источника кадров без перезапуска потока обработки.
		// Разрешение нового слота обязано совпадать с текущим: FBO создаётся
		// один раз под размер первого кадра и пересозданию здесь не подлежит.
		bool switch_slot(const std::string& slot_name);

		std::string current_slot() const;

	protected:

		void process_images(
			int fps = 20,
			std::function<void(const std::string& message)> send = nullptr
		);

		virtual void internal_handle_image(cv::Mat rgb_pixels) = 0;

		// Кадры из слота перестали приходить дольше порога. Замороженная
		// картинка неотличима от живой, поэтому наверх уходит сигнал.
		virtual void on_frames_stalled(const std::string& slot_name) {}

	private:

		void log_and_send_message(
			const std::string& message, 
			ULogger::ELoggerLevel logger_level,
			std::function<void(const std::string& message)> send = nullptr
		);

	protected:
		birdview::FEGLContext m_context;
		FFrameStorage<IFrame>* m_storage = nullptr;

		std::thread m_handler_thread;
		std::atomic<bool> m_running_thread{ false };

		// Слот читается циклом на каждой итерации, а не захватывается потоком:
		// иначе источник нельзя было бы сменить, не остановив обработку
		std::string m_storage_slot;
		mutable std::mutex m_slot_mutex;

		bool m_initialized_context{ false };

		ULogger m_logger;
	};

} // varan