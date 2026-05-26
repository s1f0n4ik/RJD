#include "core/image-handler.h"
#include "core/image-converter.h"

#include "signaling_definers.h"

namespace varan {

	UImageHandler::UImageHandler(
		birdview::UEGLContextManager* context,
		FFrameStorage<IFrame>* storage,
		ULogger::ELoggerLevel level,
		std::optional<std::string> obj_name
	)
		: m_storage(storage)
		, m_logger(obj_name ? obj_name.value() : "Image Handler", level)
	{
		if (!context->create_shared_context(m_context, &m_logger)) {
			m_logger.error("Constuctor: cannot create shared context with context manager!");
			m_initialized_context = false;
			return;
		}

		if (context->get_surface() == EGL_NO_SURFACE) {
			m_logger.info("Constuctor: successfully created shared context without surface!");
		}
		else {
			if (context->create_shared_surface(m_context.surface, m_context, &m_logger)) {
				m_logger.info("Constuctor: successfully created shared context and shared surface");
			}
			else {
				m_logger.warn("Constuctor: created shared context, but error with creation shared surface");
			}
		}
		m_initialized_context = true;
	}

	bool UImageHandler::start_handler_thread(
		const std::string& slot_name,
		int fps,
		std::function<void(const std::string& message)> send) 
	{
		if (m_running_thread || m_handler_thread.joinable()) {
			log_and_send_message("start_handler_thread(): cannot start thread, its already started!", ULogger::ELoggerLevel::WARNING, send);
			return true;
		}

		if (!m_storage || !m_storage->is_exists(slot_name)) {
			log_and_send_message("process_images(): slot " + slot_name + " at storage doesn't exists!", ULogger::ELoggerLevel::ERROR, send);
			return false;
		}

		m_running_thread = true;

		m_handler_thread = std::thread(
			&UImageHandler::process_images,
			this,
			slot_name,
			fps,
			send
		);

		return true;
	}

	bool UImageHandler::is_running() {
		return m_running_thread;
	}

	void UImageHandler::stop_handler_thread(std::function<void(const std::string& message)> send) {
		if (!m_handler_thread.joinable()) {
			log_and_send_message("stop_handler_thread(): thread is not running", ULogger::ELoggerLevel::WARNING, send);
			return;
		}

		m_running_thread = false;

		m_handler_thread.join();
		m_logger.info("stop_handler_thread(): thread stopped");
	}

	void UImageHandler::process_images(
		const std::string& storage_slot,
		int fps,
		std::function<void(const std::string& message)> send)
	{
		if (!m_initialized_context) {
			log_and_send_message("process_images(): cannot start processing loop, context doesn't initialized", ULogger::ELoggerLevel::ERROR, send);
			return;
		}

		if (!m_storage->is_exists(storage_slot)) {
			//log_and_send_message("process_images(): slot " + storage_slot + " at storage doesn't exists!", ULogger::ELoggerLevel::ERROR, send);
			return;
		}

		using clock = std::chrono::high_resolution_clock;
		// Установление контекста
		if (!eglMakeCurrent(m_context.display, m_context.surface, m_context.surface, m_context.context)) {
			log_and_send_message("process_images(): cannot start processing loop, context didn't current", ULogger::ELoggerLevel::ERROR, send);
			return;
		}

		// Установка рендера для конвертации
		auto render = UImageConverter();
		if (render.init(&m_logger) == false) {
			log_and_send_message("processing_loop(): render didn't initialize, abort linking loop!", ULogger::ELoggerLevel::ERROR, send);
			return;
		}

		// получаем время кадра
		const auto frame_time = std::chrono::microseconds(1000000 / fps);
		auto next_frame = clock::now() + frame_time;

		bool first_init = true;
		//std::vector<uint8_t> pixels;
		cv::Mat rgba;
		auto last_no_frame_warn = clock::time_point{};

		while (m_running_thread) {

			auto ptr = m_storage->extract(storage_slot);
			auto frame = dynamic_cast<UGLTextureWrapper*>(ptr.get());
			if (!frame) {
				//m_logger.trace("processing_loop(): no frame at " + storage_slot + " storage slot");
				std::this_thread::sleep_until(next_frame);
				next_frame += frame_time;
				continue;
			}

			auto width = frame->width;
			auto height = frame->height;

			if (first_init) {
				if (!render.create_fbo(width, height, &m_logger)) {
					log_and_send_message("processing_loop(): framebuffer doesn't create!",
						ULogger::ELoggerLevel::ERROR, send);
					break;
				}
				if (!render.bind_fbo()) {
					log_and_send_message("processing_loop(): framebuffer doesn't bind!",
						ULogger::ELoggerLevel::ERROR, send);
					break;
				}
				first_init = false;
			}

			glEnable(GL_DEPTH_TEST);
			glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
			glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

			render.render(frame, &m_logger);

			rgba = cv::Mat(height, width, CV_8UC4);
			glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data);

			internal_handle_image(std::move(rgba));

			// Соблюдаем FPS: если не опоздали — ждём, иначе сдвигаемся вперёд
			auto now = clock::now();
			if (next_frame < now) {
				next_frame = now + frame_time;
			}
			else {
				std::this_thread::sleep_until(next_frame);
				next_frame += frame_time;
			}
		}
		m_logger.warn("processing_loop(): exit image processing loop");
		render.unbind_fbo();
		render.destroy_fbo();
		eglMakeCurrent(m_context.display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
	}

	UImageHandler::~UImageHandler() {}

	void UImageHandler::log_and_send_message(
		const std::string& message,
		ULogger::ELoggerLevel logger_level,
		std::function<void(const std::string& message)> send) 
	{
		switch (logger_level) {
		case ULogger::ELoggerLevel::DEBUG:
			m_logger.debug(message);
			break;
		case ULogger::ELoggerLevel::ERROR:
			m_logger.error(message);
			break;
		case ULogger::ELoggerLevel::INFO:
			m_logger.info(message);
			break;
		case ULogger::ELoggerLevel::WARNING:
			m_logger.warn(message);
			break;
		case ULogger::ELoggerLevel::TRACE:
			m_logger.trace(message);
			break;
		default:
			m_logger.trace(message);
			break;
		}
		if (send) send(message);
	}

}