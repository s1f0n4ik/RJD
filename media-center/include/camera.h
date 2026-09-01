#pragma once

#include <cstdint>
#include <iostream>
#include <thread>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <condition_variable>
#include <map>
#include <vector>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <opencv2/opencv.hpp>

#include <gst/gst.h>
#include <gst/video/video.h>
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/webrtc/webrtc.h>

#include <boost/json.hpp>

#include "utility/frames.h"
#include "safe_buffers.h"
#include "isignaling.h"
#include "websocket-client.h"
#include "logger.h"
#include "webrtc_session.h"

#include "video_pipeline.h"
#include "camera-extension.h"

using namespace varan::nvr;

namespace varan {
namespace neural {

	// Приёмник кадров у каждого потока свой: кому они идут, решают назначения
	using CFrameMoverResolver = std::function<CFrameMover(const FStreamPurposes&)>;

	class UCamera : public ISignaling {
	public:

		using TUniqueGst = std::unique_ptr<GstElement, decltype(&gst_object_unref)>;
		using TUniqueBus = std::unique_ptr<GstBus, decltype(&gst_object_unref)>;

		explicit UCamera(
			const std::string& name,
			const FWebSocketOptions& socket_options,
			ULogger::ELoggerLevel level_ = ULogger::ELoggerLevel::DEBUG
		);

		virtual ~UCamera();

		virtual void set_configurations(
			const FCameraData& options,
			const std::map<std::string, FPipelineConfig>& streams_config,
			const CFrameMoverResolver& frame_resolver,
			birdview::UEGLContextManager* m_gl_manager
		);

		// Надстройка модуля над камерой; вешается до старта потоков
		void add_extension(std::unique_ptr<ICameraExtension> extension);

		bool initialize();

		// Запуск потоков обработки кадров
		bool start();

		void start_async();

		void worker();

		void stop();

		// Запуск клиента для обмена с сообщениями с сервером
		void start_websocket_client();

		void stop_websocket_client();

		void set_frame_callback(CFrameMover callback);

		void update_metadata(
			const std::string& display_name,
			const std::string& description
		);

		std::string get_name();

		// ================ Реализация интерфейса ICameraSignaling

		// Отправка сообщений клиентам
		void send_message(const std::string& message) override;

		// Обработка сообщений от клиентов
		void on_signaling_message(const std::string& msg) override;

		void set_signaling_callback(CSignalingCallback callback) override;

		FCameraStreamsData get_data();

		// Сообщение сигналинга от имени этой камеры; нужен надстройкам для ответов
		boost::json::object make_json_message(
			const std::string& client,
			bool successed,
			const std::string& type,
			const std::string& description,
			int code = 0
		);

	protected:

		// true — сообщение разобрала надстройка, общий разбор не нужен
		bool handle_module_message(
			const std::string& client_id,
			const std::string& type,
			const boost::json::object& message
		);

		// Новый идентификатор сессии; уникален в пределах камеры
		std::string make_session_id();

		// Поток, который держит сессию; nullptr — сессии нет
		UCameraPipeline* find_session_stream(const std::string& session_id, int& code);

		// Функция хелпер для выбора на какой webrtc поток отправляются сообщения
		UCameraPipeline* select_web_stream(
			const std::string& client_id,
			const std::string& type,
			const boost::json::object& message,
			int& code
		);

		// Вызывается после обработки close; stream — пайплайн, закрывший сессию
		void on_session_closed(const std::string& client_id, UCameraPipeline* stream);

		virtual std::unique_ptr<UCameraPipeline> create_pipeline(
			const std::string& name,
			const FPipelineConfig& stream_data,
			const std::string& rtsp_url,
			std::unique_ptr<ULogger> logger,
			std::function<void(std::string)> send_callback,
			CFrameMover frame_callback,
			birdview::UEGLContextManager* gl_manager
		);

	protected:

		FCameraData m_options;
		std::string m_name;

		CFrameMover m_frame_callback;
		CSignalingCallback m_signaling_callback;

		std::thread::id m_gst_loop_thread_id;

		std::atomic<bool> m_running;
		std::atomic<bool> m_is_initializing;
		std::atomic<bool> m_error;
		std::atomic<bool> m_stop_called{ false };

		// Для прерывания worker loop
		std::mutex m_worker_cv_mutex;
		std::condition_variable m_worker_cv;

		bool m_initialized;
		bool m_gst_initialized;

		GMainLoop* m_main_loop = nullptr;
		std::thread m_gst_loop_thread;
		std::atomic<bool> m_gst_loop_running{false};
		/*
			Флаг выставляется уже внутри нового потока, поэтому сразу после
			конструктора он ещё ложный. initialize() ждёт сигнала, иначе
			проигранная гонка планировщика читается как отказ камеры.
		*/
		std::mutex m_gst_loop_mutex;
		std::condition_variable m_gst_loop_cv;

		std::mutex m_init_mutex;
		std::thread m_init_thread;

		std::mutex m_signal_mutex;

		// Поля Gstream для считывания кадров
		std::map<std::string, std::unique_ptr<UCameraPipeline>> m_streams;

		// Реестр сессий, сессия нужна для просмотра одним клиентом нескольких потоков
		std::map<std::string, UCameraPipeline*> m_sessions;
		std::uint64_t m_session_counter = 0;

		// Надстройки модулей: коррекция 360 и все, что придет следом
		std::vector<std::unique_ptr<ICameraExtension>> m_extensions;

		// Ожидающая очередь для хранения пакетов
		//using UniquePacket = std::unique_ptr<AVPacket, std::function<void(AVPacket*)>>;
		//USafeQueue<UniquePacket> m_packets_buffer;

		// Клиент websocket
		FWebSocketOptions m_socket_options;

		std::shared_ptr<UWebSocketClient> m_websocket_client;
		boost::asio::io_context m_io_context;
		//boost::asio::executor_work_guard<boost::asio::io_context::executor_type> m_work_guard;

		std::thread m_websocket_thread;

		ULogger m_logger;

		// Прочее
		//static std::string make_start_timestamp();
	};

	class UVirtualCamera : public UCamera {
		public:
			explicit UVirtualCamera(
				const std::string& id,
				const FWebSocketOptions& socket_options,
				ULogger::ELoggerLevel level_ = ULogger::ELoggerLevel::DEBUG
			);

			virtual void set_configurations(
				const FCameraData& options,
				const std::map<std::string, FPipelineConfig>& streams_config,
				const CFrameMoverResolver& frame_resolver,
				birdview::UEGLContextManager* m_gl_manager
			) override;

			bool set_parameters(int width, int height, int fps);

			void push_frame(cv::Mat frame);

			std::optional<cv::Mat> get_cached_frame();

		protected:
			std::unique_ptr<UCameraPipeline> create_pipeline(
				const std::string& name,
				const FPipelineConfig& stream_data,
				const std::string& rtsp_url,
				std::unique_ptr<ULogger> logger,
				std::function<void(std::string)> send_callback,
				CFrameMover frame_callback,
				birdview::UEGLContextManager* gl_manager
			) override;

		private:
			UNV12EncodingPipeline* m_nv12_pipeline = nullptr;
	};

} // namespace neural
} // namespace varan