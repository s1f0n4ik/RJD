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

namespace varan {
namespace neural {

	using CFrameCallback = std::function<void(std::string& name, std::unique_ptr<FDrmFrame>)>;

	struct FCameraOptions {
		std::string name;
		std::string rtsp_url;
		bool b_use_udp;
		bool b_use_buffer;
		bool b_low_latency;
		int framerate;
		int probe_size;
		int analyze_duration;
		int reconnect_delay;
		size_t buff_reading_size;
	};

	struct FInternalCameraOpts {
		std::string codec_name = "";
		std::string profile = "";
		int framerate_num = 0;
		int framerate_den = 0;
		int width = 0;
		int height = 0;
		bool ready = false;
	};

	class UCamera : public ICameraSignaling {
	public:

		using TUniqueGst = std::unique_ptr<GstElement, decltype(&gst_object_unref)>;
		using TUniqueBus = std::unique_ptr<GstBus, decltype(&gst_object_unref)>;

		struct FWebRtcSession {
			CSignalingCallback send_callback;
			std::string client_id;
			std::string camera_name;
			TUniqueGst webrtcbin;
			TUniqueGst queue;

			FWebRtcSession(const std::string& client_id_, const std::string& camera_name_, CSignalingCallback callback_)
				: client_id(client_id_)
				, camera_name(camera_name_)
				, webrtcbin(nullptr, gst_object_unref)
				, queue(nullptr, gst_object_unref) 
				, send_callback(std::move(callback_))
			{}

			~FWebRtcSession() {
				if (webrtcbin) {
					gst_element_set_state(webrtcbin.get(), GST_STATE_NULL);
				}
				if (queue) {
					gst_element_set_state(queue.get(), GST_STATE_NULL);
				}
			}

			void send_message(const std::string& message) { send_callback(message); }
		};

		explicit UCamera(const FCameraOptions& options);

		~UCamera();

		bool initialize();

		// Запуск потоков обработки кадров
		bool start();

		void stop();

		// Запуск клиента для обмена с сообщениями с сервером
		void start_websocket_client(const std::string& ip_adress, const std::string& port, const std::string& url);

		void stop_websocket_client();

		void set_frame_callback(CFrameCallback callback);

		bool create_gst_pipeline_read_frames();

		bool create_gst_pipeline_webrtc();

		std::string get_name();

		// ================ Реализация интерфейса ICameraSignaling

		// Отправка сообщений клиентам
		void send_message(const std::string& message) override;

		// Обработка сообщений от клиентов
		void on_signaling_message(const std::string& msg) override;

		void set_signaling_callback(CSignalingCallback callback) override;

	private:
		FCameraOptions m_options;
		FInternalCameraOpts m_internal_options;

		CFrameCallback m_frame_callback;
		CSignalingCallback m_signaling_callback;

		std::atomic<bool> m_running;
		std::atomic<bool> m_error;

		bool m_initialized;
		bool m_gst_initialized;

		std::thread m_reading_thread;
		//std::thread m_decode_thread;
		//std::thread m_push_thread;

		GMainLoop* m_main_loop = nullptr;
		std::thread m_gst_loop_thread;

		std::mutex m_signal_mutex;

		// Поля Gstream для считывания кадров
		TUniqueGst m_reading_pipeline;

		// Ожидающая очередь для хранения пакетов
		//using UniquePacket = std::unique_ptr<AVPacket, std::function<void(AVPacket*)>>;
		//USafeQueue<UniquePacket> m_packets_buffer;

		// Ожидающая очередь для хранения фреймов drm
		// Хранит для потока, который отправляет в GStream pipeline
		USafeQueue<std::unique_ptr<FDrmFrame>> m_frames_buffer;

		// Поля для GStream
		TUniqueGst m_webrtcbin_pipeline;
		TUniqueGst m_webrtcbin_appsrc;
		TUniqueGst m_webrtcbin_tee;

		std::map<std::string, std::unique_ptr<FWebRtcSession>> m_opened_sessions;
		std::mutex m_session_mutex;
		std::condition_variable m_session_cv;
		bool m_has_sessions = false;

		// Клиент websocket
		std::shared_ptr<UWebSocketClient> m_websocket_client;
		boost::asio::io_context m_io_context;
		boost::asio::executor_work_guard<boost::asio::io_context::executor_type> m_work_guard;

		std::thread m_websocket_thread;

		// GStreamer Проверка кадров, получение инфы с камер

		static void on_rtsp_pad_added(GstElement* element, GstPad* pad, gpointer data);

		static GstPadProbeReturn on_parser_event(GstPad* pad, GstPadProbeInfo* probe_info, gpointer data);

		bool try_camera_probe(int timeout_sec, std::string& error_out);

		bool probe_camera_with_reconnect(int attempts = 10, int timeout = 2, int delay = 2);

		// GStreamer Считывание кадров с камеры

		// GStreamer WebRTC

		void push_frames_to_gst_pipeline();

		bool set_streaming_pipeline_state(GstState state);

		void open_new_session(const std::string& client_id);

		void close_session(const std::string& client_id);

		static void on_negotiation_needed(GstElement* webrtcbin, gpointer data);

		static void on_offer_created(GstPromise* promise, gpointer data);

		static void on_ice_candidate(GstElement* webrtcbin, guint mlineindex, gchar* candidate, gpointer data);

		static void on_ice_connection_state(GstElement* session, GstWebRTCICEConnectionState state, gpointer data);

		// ==================================================================
		// json сообщений
		// ==================================================================

		static boost::json::object json(
			const FWebRtcSession* session, 
			bool successed, 
			const std::string& type, 
			const std::string& description
		);

		static boost::json::object json(
			const std::string& camera, 
			const std::string& client, 
			bool successed, 
			const std::string& type, 
			const std::string& description
		);
	};

} // namespace neural
} // namespace varan