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
		const std::string& name,
		const FWebSocketOptions& socket_options,
		ULogger::ELoggerLevel level_
	)
		: m_running(false)
		, m_error(false)
		, m_initialized(false)
		, m_gst_initialized(false)
		, m_io_context()
		, m_websocket_client(nullptr)
		, m_socket_options(socket_options)
		, m_logger(name, level_)
	{
		m_main_loop = g_main_loop_new(nullptr, FALSE);
		if (!m_main_loop) {
			m_gst_loop_running = false;
			return;
		}

		m_gst_loop_thread = std::thread([this]() {
			m_gst_loop_thread_id = std::this_thread::get_id();
			m_gst_loop_running = true;
			g_main_loop_run(m_main_loop);
			m_gst_loop_running = false;
		});
	};

	void UCamera::set_configurations(
		const FCameraData& options,
		const std::map<std::string, FPipelineConfig>& streams_config,
		CFrameMover dmabuf_callback,
		birdview::UEGLContextManager* m_gl_manager
	) {
		// Удаление текущий стримов
		m_streams.clear();
		m_initialized = false;
		// Создание новых
		m_options = options;
		for (const auto& [name, stream_data] : streams_config) {
			// Проверка на существование pipeline
			auto it = m_streams.find(name);
			if (it != m_streams.end()) {
				m_logger.error("Camera constructor: Pipeline with name " + name + " already exists!");
				continue;
			}

			// Создание ссылки
			const auto it_maker = rtsp_maker.find(options.production);
			const auto& maker = (it_maker != rtsp_maker.end()) ? it_maker->second : rtsp_maker.at(ERtspType::ACE);
			std::string rtsp_url = maker(options.ip_adress, options.port, options.user, options.password, stream_data.stream);

			// Копирование конфига
			FPipelineConfig pipeline_setting = stream_data;
			pipeline_setting.camera_name = options.id;
			pipeline_setting.name = name;
			pipeline_setting.rtsp_url = rtsp_url;
			pipeline_setting.stream = stream_data.stream;
			pipeline_setting.to_record = stream_data.to_record;

			auto pipe_logger = std::make_unique<ULogger>(m_options.id + ": " + name, m_logger.get_level());
			auto send_callback = [this](std::string msg) {this->send_message(std::move(msg)); };

			try {
				m_streams[name] = create_pipeline(
					name,
					pipeline_setting,
					rtsp_url,
					std::move(pipe_logger),
					send_callback,
					std::move(dmabuf_callback),
					m_gl_manager
				);
			}
			catch (const std::exception& e) {
				m_logger.error("Camera constructor: " + std::string(e.what()));
				continue;
			}
		}
	}

	std::unique_ptr<UCameraPipeline> UCamera::create_pipeline(
		const std::string& name,
		const FPipelineConfig& stream_data,
		const std::string& rtsp_url,
		std::unique_ptr<ULogger> logger,
		std::function<void(std::string)> send_callback,
		CFrameMover frame_callback,
		birdview::UEGLContextManager* gl_manager
	) {
		switch (stream_data.type) {
		case EPilelineType::SUB:
			return std::make_unique<UCameraSubPipeline>(
				stream_data,
				std::move(logger),
				std::move(send_callback)
			);

		case EPilelineType::MAIN:
		default:
			return std::make_unique<UCameraMainPipeline>(
				stream_data,
				std::move(logger),
				std::move(send_callback),
				gl_manager,
				std::move(frame_callback)
			);
		}
	}

	UCamera::~UCamera() { 
		stop(); 

		// Остановка главного потока
		if (m_main_loop) {
			g_main_loop_quit(m_main_loop);
			m_logger.debug("stop(): stopped g_main_loop");
		}

		if (m_gst_loop_thread.joinable()) {
			m_gst_loop_thread.join();
		}

		// Убийство главного потока
		if (m_main_loop) {
			g_main_loop_unref(m_main_loop);
			m_main_loop = nullptr;
		}
	}

	bool UCamera::initialize() {
		if (m_initialized) return true;

		if (!m_gst_loop_running) {
			m_logger.error("initialize(): False to initialize + " + m_name + " camera, main_g_loop didn't run");
			return false;
		}

		try {
			if (m_stop_called.load()) {
				m_logger.info("initialize(): stop requested, aborting");
				return false;
			}

			for (const auto& [name, stream] : m_streams) {
				if (stream->initialize() == false) {
					m_logger.error("initialize(): False to initialize " + name + " pipeline!");
					return false;
				}
			}

			m_initialized = true;
			return true;
		}
		catch (const std::runtime_error& error) {
			std::cerr << error.what();
			return false;
		}
	}

	std::string UCamera::get_name() {
		if (m_initialized) {
			return m_options.id;
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
			m_logger.warn("start_async(): camera is already running!");
			return;
		}

		m_stop_called = false;
		m_is_initializing = true;

		if (m_init_thread.joinable()) {
			m_init_thread.join();
		}

		m_init_thread = std::thread(&UCamera::worker, this);
	}

	void UCamera::worker() {
		while (!m_stop_called.load())
		{
			if (initialize()) break;

			std::unique_lock<std::mutex> lk(m_worker_cv_mutex);
			m_worker_cv.wait_for(lk, std::chrono::seconds(2),
				[this] { return m_stop_called.load(); }
			);
		}

		m_is_initializing = false;

		if (m_stop_called.load()) {
			m_logger.info("worker(): stop requested during init, exiting");
			return;
		}

		if (!start()) {
			m_logger.error("Camera failed to start");
			m_running = false;
			return;
		}

		m_running = true;
	}

	void UCamera::stop() 
	{
		if (m_stop_called.exchange(true)) {
			m_logger.warn("stop(): already called, ignoring");
			return;
		}

		// Остановка вебсокета
		stop_websocket_client();
		m_logger.debug("stop(): stopped websocket");

		// Запршиваем остановку пайплайлна
		for (auto& [name, stream] : m_streams) {
			stream->request_stop();
		}

		m_worker_cv.notify_all();

		if (m_init_thread.joinable()) {
			m_init_thread.join();
		}
		m_logger.warn("stop(): called!");
		// Останавливаем пайплайны через GMainLoop (его поток)
		if (m_main_loop && m_gst_loop_running) {
			bool called_from_gst_thread = (std::this_thread::get_id() == m_gst_loop_thread_id);
			if (called_from_gst_thread) {
				// Удаляем напрямую
				m_logger.debug("stop(): clearing all streams directly!");
				m_streams.clear();
			}
			else {
				std::promise<void> done;
				auto future = done.get_future();

				// Структура для передачи в idle callback
				struct StopCtx {
					UCamera* self;
					std::promise<void> done;
				};
				auto* ctx = new StopCtx{ this, std::move(done) };

				g_main_context_invoke(
					g_main_loop_get_context(m_main_loop),
					+[](gpointer data) -> gboolean {
						auto* ctx = static_cast<StopCtx*>(data);
						// Теперь мы в потоке GMainLoop — teardown безопасен
						ctx->self->m_streams.clear(); // деструкторы вызовут teardown
						ctx->done.set_value();
						delete ctx;
						return G_SOURCE_REMOVE;
					},
					ctx
				);
				m_logger.debug("stop(): inoked stop to the main gloop thread!");
				// Ждём завершения teardown
				if (future.wait_for(std::chrono::seconds(5)) == std::future_status::timeout) {
					m_logger.error("stop(): teardown timeout! Cleanup");
				}
			}
		}
		else {
			m_logger.debug("stop(): simply delete streams");
			m_streams.clear();
		}

		m_running = false;
		m_initialized = false;

		m_logger.info("stop(): done");
	}

	void UCamera::set_frame_callback(CFrameMover callback) {
		m_frame_callback = std::move(callback);
	}

	void UCamera::update_metadata(
		const std::string& display_name,
		const std::string& description)
	{
		m_options.display_name = display_name;
		m_options.description = description;
	}

	// ===========================================================
	// Релиазация обмена сообщений SDP и ICE
	// ===========================================================

	void UCamera::start_websocket_client()
	{
		if (m_websocket_thread.joinable()) {
			m_logger.warn("start_websocket_client(): already running");
			return;
		}

		std::string url = "/camera/" + m_options.id;

		// Рестарт на случай, если он был остановлен
		m_io_context.restart();

		if (!m_websocket_client) {
			m_websocket_client = std::make_shared<UWebSocketClient>(m_io_context, m_socket_options.ip_adress, m_socket_options.port, url, m_options.id);
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

		m_io_context.stop();

		if (m_websocket_thread.joinable()) {
			m_websocket_thread.join();
		}

		m_websocket_client.reset();
	}

	void UCamera::on_signaling_message(const std::string& msg) {
		try {
			if (m_stop_called.load()) return;
			m_logger.debug("on_signaling_message(): proccessing message " + msg);
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
				if (stream->get_type() == EPilelineType::SUB || stream->get_type() == EPilelineType::NV12_ENCODER) {
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
			std::cout << color::red << "[UCamera " << m_options.id << "] Cannot send message because websocket client is nullptr!\n" << color::reset;
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
		message[SIG_CAMERA] = m_options.id;
		message[SIG_DECRIPTION] = description;
		return message;
	}

	FCameraStreamsData UCamera::get_data()
	{
		FCameraStreamsData data;
		for (const auto& [name, pipeline] : m_streams) {
			data.pipelines[name] = std::move(pipeline->get_pipeline_data());
		}
		data.camera = m_options;

		return data;
	}

} // namespace neural
} // namespace varan