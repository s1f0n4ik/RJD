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
//#include <opencv2/opencv.hpp>

#include <gst/gst.h>
#include <gst/video/video.h>
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/webrtc/webrtc.h>

#include <boost/json.hpp>


extern "C" {
	#include <libavformat/avformat.h>
	#include <libavcodec/avcodec.h>
	#include <libswscale/swscale.h>
	#include <libavutil/imgutils.h>
}

#include "drm_frame.h"
#include "safe_buffers.h"
#include "icamera_signaling.h"
#include "iwebsocket_client.h"
#include "logger.h"
#include "webrtc_session.h"

namespace varan {
namespace neural {

	using CFrameCallback = std::function<void(std::string& name, std::unique_ptr<FDrmFrame>)>;

	struct FCameraOptions {
		std::string name;
		std::string rtsp_url; // полная ссылка с логином и паролем

		std::filesystem::path record_path = ""; // путь абсолютный
		int segment_duration = 600; // в секундах

		bool b_use_udp;
		bool b_use_buffer;
		bool b_low_latency;
		int framerate;
		int probe_size;
		int analyze_duration;
		int reconnect_delay; // в секундах
	};

	struct FWebSocketOptions {
		std::string ip_adress;
		std::string port;
	};

	struct FProbeResult {
		std::string codec_name = "";
		std::string profile = "";
		int framerate_num = 0;
		int framerate_den = 0;
		int width = 0;
		int height = 0;

		bool ready = false;

		GstElement* sink_element = nullptr;
		GstElement* depay = nullptr;
	};

	class UCamera : public ICameraSignaling {
	public:

		using TUniqueGst = std::unique_ptr<GstElement, decltype(&gst_object_unref)>;
		using TUniqueBus = std::unique_ptr<GstBus, decltype(&gst_object_unref)>;

		explicit UCamera(
			const FCameraOptions& options, 
			const FWebSocketOptions& socket_options, 
			ULogger::ELoggerLevel level_ = ULogger::ELoggerLevel::DEBUG
		);

		~UCamera();

		bool initialize();

		// Запуск потоков обработки кадров
		bool start();

		void stop();

		// Запуск клиента для обмена с сообщениями с сервером
		void start_websocket_client();

		void stop_websocket_client();

		void set_frame_callback(CFrameCallback callback);

		std::string get_name();

		// ================ Реализация интерфейса ICameraSignaling

		// Отправка сообщений клиентам
		void send_message(const std::string& message) override;

		// Обработка сообщений от клиентов
		void on_signaling_message(const std::string& msg) override;

		void set_signaling_callback(CSignalingCallback callback) override;

	private:
		FCameraOptions m_options;
		FProbeResult m_probe_result;

		CFrameCallback m_frame_callback;
		CSignalingCallback m_signaling_callback;

		std::atomic<bool> m_running;
		std::atomic<bool> m_error;

		bool m_initialized;
		bool m_gst_initialized;

		GMainLoop* m_main_loop = nullptr;
		std::thread m_gst_loop_thread;
		std::atomic<bool> m_gst_loop_running{false};

		std::mutex m_signal_mutex;

		// Поля Gstream для считывания кадров
		TUniqueGst m_reading_pipeline;
		TUniqueGst m_reading_tee;

		// Ожидающая очередь для хранения пакетов
		//using UniquePacket = std::unique_ptr<AVPacket, std::function<void(AVPacket*)>>;
		//USafeQueue<UniquePacket> m_packets_buffer;

		// Ожидающая очередь для хранения фреймов drm
		// Хранит для потока, который отправляет в GStream pipeline
		USafeQueue<std::unique_ptr<FDrmFrame>> m_frames_buffer;

		// Поля для GStream
		FWebSocketOptions m_socket_options;

		TUniqueGst m_webrtcbin_pipeline;
		TUniqueGst m_webrtcbin_appsrc;
		TUniqueGst m_webrtcbin_tee;

		std::map<std::string, std::unique_ptr<UWebRTCSession>> m_opened_sessions;
		std::mutex m_session_mutex;
		std::condition_variable m_session_cv;
		bool m_has_sessions = false;

		// Клиент websocket
		std::shared_ptr<UWebSocketClient> m_websocket_client;
		boost::asio::io_context m_io_context;
		boost::asio::executor_work_guard<boost::asio::io_context::executor_type> m_work_guard;

		std::thread m_websocket_thread;

		ULogger m_logger;

		// GStreamer Проверка кадров, получение инфы с камер

		static void on_rtspsrc_pad_added(GstElement* src, GstPad* pad, gpointer user_data);

		static void on_rtspsrc_pad_depay_added(GstElement* src, GstPad* pad, gpointer user_data);

		static GstPadProbeReturn on_rtsp_caps_event(GstPad* pad, GstPadProbeInfo* info, gpointer user_data);

		static GstPadProbeReturn on_parse_caps_event(GstPad* pad, GstPadProbeInfo* info, gpointer user_data);

		bool codec_check_probe(int timeout_sec);

		bool camera_probe(int timeout_sec);

		bool probe_camera_with_reconnect(int attempts = 10, int timeout = 2, int delay = 2);

		// GStreamer Считывание кадров с камеры

		bool initialize_reading_pipeline();

		bool start_reading_pipeline();

		// GStreamer WebRTC

		void open_new_session(const std::string& client_id);

		void close_session(const std::string& client_id);

		// ==================================================================
		// json сообщений
		// ==================================================================

		boost::json::object json(
			const std::string& client,
			bool successed,
			const std::string& type,
			const std::string& description
		);

		// Прочее

		static std::string make_start_timestamp();
	};

} // namespace neural
} // namespace varan