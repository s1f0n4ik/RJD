#include "camera.h"
#include <gst/gst.h>
#include <gst/allocators/allocators.h>
#include <gst/webrtc/webrtc.h>
#include <ranges>

#include "console_utility.h"
#include "video_utility.h"
#include "signaling_definers.h"
#include "utility/json-definers.h"

#include <gst/rtsp/gstrtsptransport.h>

namespace varan {
namespace neural {

	UCamera::UCamera(
		const FCameraData& options,
		const FWebSocketOptions& socket_options,
		ULogger::ELoggerLevel level_)
		: m_name(options.name)
		, m_description(options.description)
		, m_ip_adress(options.ip_adress)
		, m_port(options.port)
		, m_user(options.user)
		, m_running(false)
		, m_error(false)
		, m_initialized(false)
		, m_gst_initialized(false)
		, m_frames_buffer(1)
		, m_io_context()
		, m_work_guard(boost::asio::make_work_guard(m_io_context))
		, m_websocket_client(nullptr)
		, m_socket_options(socket_options)
		, m_logger(options.name, level_)
	{
		for (const auto& [name, stream_data] : options.pipelines) {
			auto pipeline_setting = FInputPipelineParameters{
				name, m_name,
				stream_data.rtsp_url, stream_data.latency, stream_data.use_udp, stream_data.reconnect_time,
				stream_data.record_path, stream_data.segment_length
			};
			// Проверка на существование pipeline
			auto it = m_streams.find(name);
			if (it != m_streams.end()) {
				m_logger.error("Camera constructor: Pipeline with name " + name + " already exists!");
				continue;
			}

			auto pipe_logger = std::make_unique<ULogger>(m_name + ": " + name, m_logger.get_level());
			auto send_callback = [this](std::string msg) {this->send_message(std::move(msg)); };

			switch (stream_data.type) {
				case EPilelineType::SUB: {
					m_streams[name] = std::make_unique<UCameraSubPipeline>(
						pipeline_setting,
						std::move(pipe_logger),
						std::move(send_callback)
					);
					break;
				}
				default: {
					m_streams[name] = std::make_unique<UCameraMainPipeline>(
						pipeline_setting,
						std::move(pipe_logger),
						std::move(send_callback)
					);
					break;
				}
			}
		}
	};

	UCamera::~UCamera() { 
		stop(); 
	}

	bool UCamera::initialize() {
		if (m_initialized) return true;

		auto start_g_loop = [&]() {
			m_main_loop = g_main_loop_new(nullptr, FALSE);
			m_gst_loop_thread = std::thread([this]() {
				g_main_loop_run(m_main_loop);
			});
		};

		auto stop_g_loop = [&]() {
			if (m_main_loop) {
				g_main_loop_quit(m_main_loop);
			}
			if (m_gst_loop_thread.joinable()) {
				m_gst_loop_thread.join();
			}
			if (m_main_loop) {
				g_main_loop_unref(m_main_loop);
				m_main_loop = nullptr;
			}
		};

		try {
			start_g_loop();
			
			for (const auto& [name, stream] : m_streams) {
				if (stream->initialize() == false) {
					m_logger.error("False to initialize " + name + " pipeline!");
					stop_g_loop();
					return false;
				}
			}

			m_initialized = true;
			return true;
		}
		catch (const std::runtime_error& error) {
			std::cerr << error.what();
			stop_g_loop();
			return false;
		}
	}

	std::string UCamera::get_name() {
		if (m_initialized) {
			return m_name;
		}
		else {
			return "Camera has not inititalized!";
		}
	}

	bool UCamera::start() {
		if (m_running) return true;

		start_websocket_client();

		for (const auto& [name, stream] : m_streams) {
			if (stream->start() == false) {
				m_logger.error("False to start " + name + " pipeline!");
				return false;
			}
		}

		m_running = true;
		return true;
	}

	void UCamera::start_async() {
		std::lock_guard<std::mutex> lk(m_init_mutex);

		if (m_running || m_is_initializing) {
			return;
		}

		m_stop_requested = false;
		m_is_initializing = true;

		m_init_thread = std::thread(&UCamera::worker, this);
	}

	void UCamera::worker()
	{
		//constexpr auto TIMEOUT = std::chrono::seconds(120);
		//auto start_time = std::chrono::steady_clock::now();

		while (!m_stop_requested)
		{
			if (initialize()) break;

			//if (std::chrono::steady_clock::now() - start_time > TIMEOUT)
			//{
			//	m_logger.error("Camera initialization timeout");
			//	m_error = true;
			//	m_is_initializing = false;
			//	return;
			//}

			std::this_thread::sleep_for(std::chrono::seconds(2));
		}

		if (m_stop_requested) {
			m_is_initializing = false;
			return;
		}

		m_is_initializing = false;

		if (!start()) {
			m_logger.error("Camera failed to start");
			m_error = true;
			return;
		}

		m_running = true;
	}

	void UCamera::stop() 
	{
		{
			std::lock_guard<std::mutex> lk(m_init_mutex);
			m_stop_requested = true;
		}

		if (m_init_thread.joinable()) {
			m_init_thread.join();
		}

		// Остановка вебсокета
		stop_websocket_client();

		// Остановка главного потока
		if (m_main_loop) {
			g_main_loop_quit(m_main_loop);
		}

		if (m_gst_loop_thread.joinable()) {
			m_gst_loop_thread.join();
		}

		// Убийство главного потока
		if (m_main_loop) {
			g_main_loop_unref(m_main_loop);
			m_main_loop = nullptr;
		}

		// Убийство всех пайплайнов
		m_streams.clear();

		m_running = false;
	}

	void UCamera::set_frame_callback(CFrameCallback callback) {
		m_frame_callback = std::move(callback);
	}

	// ===========================================================
	// Релиазация обмена сообщений SDP и ICE
	// ===========================================================

	void UCamera::start_websocket_client()
	{
		std::string url = "/camera/" + m_name;
		if (!m_websocket_client) {
			m_websocket_client = std::make_shared<UWebSocketClient>(m_io_context, m_socket_options.ip_adress, m_socket_options.port, url, m_name);
		}

		m_websocket_client->set_message_callback(
			[this](const std::string& message) {
				this->on_signaling_message(message);
			}
		);

		m_websocket_thread = std::thread([this]() {
			try {
				m_websocket_client->run();

				m_io_context.run();
			}
			catch (std::exception& error) {
				std::cerr << color::red << "[UCamera] Start websocket client error: " << error.what() << color::reset << std::endl;
			}
			});
	}

	void UCamera::stop_websocket_client()
	{
		if (m_websocket_client) {
			m_websocket_client->stop();
		}

		m_work_guard.reset();
		m_io_context.stop();

		if (m_websocket_thread.joinable()) {
			m_websocket_thread.join();
		}

		m_websocket_client.reset();
	}

	void UCamera::on_signaling_message(const std::string& msg) {
		try {
			boost::json::value parsed = boost::json::parse(msg);
			boost::json::object& json_object = parsed.as_object();

			// Узнаем идентификатор клиента
			std::string client_id;
			if (auto* v = json_object.if_contains("client_id"); v && v->is_string()) {
				client_id = v->as_string().c_str();
			}
			else {
				m_logger.error("Error with recieving message: missing client id!");
				return;
			}

			// Проверяем тип сообщения
			std::string type;
			if (auto* v = json_object.if_contains("type"); v && v->is_string()) {
				type = v->as_string().c_str();
			}
			else {
				m_logger.error("Error while receiving message: missing type!");
				return;
			}

			std::string description;
			UCameraPipeline* web_stream = nullptr;
			for (const auto& [name, stream] : m_streams) {
				if (stream->get_type() == EPilelineType::SUB) {
					web_stream = stream.get();
					break;
				}
			}
			if (!web_stream) {
				std::string text = "There is no sub pipeline in camera to get webrtc session!";
				m_logger.debug(text);
				send_message(
					boost::json::serialize(
						make_json_message(client_id, false, type, text)
					)
				);
				return;
			}
			// Запрос на соединение
			if (type == "connection" || type == "close") {
				const bool ret = (type == "connection")
					? web_stream->create_webrtc_session(client_id, description)
					: web_stream->close_webrtc_session(client_id, description);

				ret ? m_logger.info(description) : m_logger.error(description);

				send_message(
					boost::json::serialize(
						make_json_message(client_id, ret, type, description)
					)
				);

				return;
			}
			else {
				auto ret = web_stream->process_webrtc_session(client_id, json_object, type, description);
				ret ? m_logger.info(description) : m_logger.error(description);
				//send_message(
				//	boost::json::serialize(
				//		json(client_id, ret, type, description)
				//	)
				//);
			}
		}
		catch (const std::exception e) {
			std::string err_text = "Unexpected error: " + std::string(e.what());
			m_logger.error(err_text);
			send_message(
				boost::json::serialize(
					make_json_message("", false, "fault", err_text)
				)
			);
		}
	}

	void UCamera::set_signaling_callback(CSignalingCallback callback) {
		m_signaling_callback = std::move(callback);
	}

	void UCamera::send_message(const std::string& message)
	{
		std::lock_guard lock(m_signal_mutex);
		if (m_websocket_client) {
			m_websocket_client->send(message);
		}
		else {
			std::cout << color::red << "[UCamera " << m_name << "] Cannot send message because websocket client is nullptr!\n" << color::reset;
		}
	}

	boost::json::object UCamera::make_json_message(
		const std::string& client,
		bool successed,
		const std::string& type,
		const std::string& description
	) 
	{
		boost::json::object message;
		message[SIG_TYPE] = type;
		message[SIG_SENDER] = SIG_SENDER_CAMERA;
		message[SIG_RET] = successed ? SIG_RET_SUCCESS : SIG_RET_FAULT;
		message[SIG_CLIENT] = client;
		message[SIG_CAMERA] = m_name;
		message[SIG_DECRIPTION] = description;
		return message;
	}

	FCameraData UCamera::get_data()
	{
		FCameraData data;
		for (const auto& [name, pipeline] : m_streams) {
			data.pipelines[name] = std::move(pipeline->get_pipeline_data());
		}
		data.name = m_name;
		data.description = m_description;
		data.user = m_user;
		data.ip_adress = m_ip_adress;
		data.port = m_port;

		return data;
	}

} // namespace neural
} // namespace varan