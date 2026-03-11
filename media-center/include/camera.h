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

#include "utility/dma-frame.h"
#include "safe_buffers.h"
#include "icamera_signaling.h"
#include "iwebsocket_client.h"
#include "logger.h"
#include "webrtc_session.h"

#include "video_pipeline.h"

using namespace varan::nvr;

namespace varan {
namespace neural {

	class UCamera : public ICameraSignaling {
	public:

		using TUniqueGst = std::unique_ptr<GstElement, decltype(&gst_object_unref)>;
		using TUniqueBus = std::unique_ptr<GstBus, decltype(&gst_object_unref)>;

		explicit UCamera(
			const FCameraData& options, 
			const FWebSocketOptions& socket_options, 
			CDmabufMover dmabuf_callback,
			ULogger::ELoggerLevel level_ = ULogger::ELoggerLevel::DEBUG
		);

		~UCamera();

		bool initialize();

		// Запуск потоков обработки кадров
		bool start();

		void start_async();

		void worker();

		void stop();

		// Запуск клиента для обмена с сообщениями с сервером
		void start_websocket_client();

		void stop_websocket_client();

		void set_frame_callback(CDmabufMover callback);

		std::string get_name();

		// ================ Реализация интерфейса ICameraSignaling

		// Отправка сообщений клиентам
		void send_message(const std::string& message) override;

		// Обработка сообщений от клиентов
		void on_signaling_message(const std::string& msg) override;

		void set_signaling_callback(CSignalingCallback callback) override;

		FCameraData get_data();

	private:
		std::string m_name;
		std::string m_description;

		std::string m_ip_adress;
		std::string m_port;
		std::string m_user;

		ECameraType m_type;

		CDmabufMover m_frame_callback;
		CSignalingCallback m_signaling_callback;

		std::atomic<bool> m_running;
		std::atomic<bool> m_stop_requested;
		std::atomic<bool> m_is_initializing;
		std::atomic<bool> m_error;

		bool m_initialized;
		bool m_gst_initialized;

		GMainLoop* m_main_loop = nullptr;
		std::thread m_gst_loop_thread;
		std::atomic<bool> m_gst_loop_running{false};

		std::mutex m_init_mutex;
		std::thread m_init_thread;

		std::mutex m_signal_mutex;

		// Поля Gstream для считывания кадров
		std::map<std::string, std::unique_ptr<UCameraPipeline>> m_streams;

		// Ожидающая очередь для хранения пакетов
		//using UniquePacket = std::unique_ptr<AVPacket, std::function<void(AVPacket*)>>;
		//USafeQueue<UniquePacket> m_packets_buffer;

		// Клиент websocket
		FWebSocketOptions m_socket_options;

		std::shared_ptr<UWebSocketClient> m_websocket_client;
		boost::asio::io_context m_io_context;
		boost::asio::executor_work_guard<boost::asio::io_context::executor_type> m_work_guard;

		std::thread m_websocket_thread;

		ULogger m_logger;

		// ==================================================================
		// json сообщений
		// ==================================================================

		boost::json::object make_json_message(
			const std::string& client,
			bool successed,
			const std::string& type,
			const std::string& description
		);
		// Прочее
		//static std::string make_start_timestamp();
	};

} // namespace neural
} // namespace varan