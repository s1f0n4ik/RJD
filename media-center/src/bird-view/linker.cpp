#include "bird-view/linker.h"
#include "bird-view/renderer.h"
#include "bird-view/egl-context.h"

#include "utility/fd-monitor.h"

#include <opencv2/opencv.hpp>

namespace varan {
namespace birdview {

	ULinker::ULinker(
		const nvr::FWebSocketOptions& websocket,
		UEGLContextManager* manager,
		FFrameStorage<IFrame>* storage,
		ULogger::ELoggerLevel level
	)
		: m_logger("Bird ULinker", level)
		, m_storage(storage)
		, m_context_manager(manager)
	{
	}



	ULinker::~ULinker() {
		stop();
	}

	void ULinker::set_stitching_mode(EBirdViewStitchingMode mode) {
		m_cameras_purpose.clear();
		switch (mode) {
			case EBirdViewStitchingMode::SIX_CAMERAS:
				m_cameras_purpose.emplace(EBirdCameraType::FRONT, std::nullopt);
				m_cameras_purpose.emplace(EBirdCameraType::RIGHT_FRONT, std::nullopt);
				m_cameras_purpose.emplace(EBirdCameraType::RIGHT_BACK, std::nullopt);
				m_cameras_purpose.emplace(EBirdCameraType::BACK, std::nullopt);
				m_cameras_purpose.emplace(EBirdCameraType::LEFT_BACK, std::nullopt);
				m_cameras_purpose.emplace(EBirdCameraType::LEFT_FRONT, std::nullopt);
				break;
			case EBirdViewStitchingMode::FOUR_CAMERAS:
				m_cameras_purpose.emplace(EBirdCameraType::FRONT, std::nullopt);
				m_cameras_purpose.emplace(EBirdCameraType::RIGHT_FRONT, std::nullopt);
				m_cameras_purpose.emplace(EBirdCameraType::BACK, std::nullopt);
				m_cameras_purpose.emplace(EBirdCameraType::LEFT_FRONT, std::nullopt);
				break;
			default:
				return;
		}
	}

	bool ULinker::set_render_camera(EBirdCameraType type, std::string camera) {
		std::string type_string = from_bird_camera_type_to_string(type);
		auto it_camera = m_cameras_purpose.find(type);
		if (it_camera == m_cameras_purpose.end()) {
			m_logger.error("set_render_camera(): there is no camera " + type_string + " at linker!");
			return false;
		}

		it_camera->second = camera;
		m_logger.debug("set_render_camera(): setting " + type_string + " camera to " + camera);
		return true;
	}

	bool ULinker::async_start(uint32_t fps) {
		if (m_running) return false;

		m_running = true;

		m_worker = std::thread(&ULinker::processing_loop, this, fps);

		return true;
	}

	void ULinker::stop() {
		if (!m_running) return;

		m_running = false;

		if (m_worker.joinable()) {
			m_worker.join();
		}
	}

	void ULinker::processing_loop(uint32_t fps)
	{
		if (!m_context_manager) {
			m_logger.error("processing_loop(): cannot start render loop, context doesn't initialized");
			return;
		}
		using clock = std::chrono::high_resolution_clock;
		// Установление контекста
		if (!m_context_manager->make_current(&m_logger)) {
			return;
		}
		if (!m_context_manager->init_render_framebuffer(1024, 1024, &m_logger)) {
			m_logger.error("processing_loop(): render framebuffer didn't initialize, abort linking loop!");
			return;
		}
		else {
			m_logger.info("processing_loop(): render framebuffer successfully initialized with (" + std::to_string(1024) + "," + std::to_string(1024) + ")");
		}
		glBindFramebuffer(GL_FRAMEBUFFER, m_context_manager->get_fbo());
		// инициализация ренждера
		/*
		EGLContext ctx = eglGetCurrentContext();
		if (ctx == EGL_NO_CONTEXT) {
			m_logger.error("No current EGL context!");
		}
		else {
			m_logger.info("EGL context is current: " + std::to_string((uintptr_t)ctx));
		}
		*/
		auto render = UCubeRenderer();
		if (render.init(m_cameras_purpose.size(), m_context_manager, &m_logger) == false) {
			m_logger.error("processing_loop(): render didn't initialize, abort linking loop!");
			return;
		}

		std::string video_path = "/home/orangepi/render/output.avi";
		cv::VideoWriter writer;
		writer.open(video_path, cv::VideoWriter::fourcc('M', 'J', 'P', 'G'), fps, cv::Size(1024, 1024));

		if (!writer.isOpened()) {
			m_logger.error("processing_loop(): cannot open VideoWriter!");
			return;
		}

		// Собираем хранилище для кажров
		auto space = create_linking_space();
		// получаем время кадра
		const auto frame_time = std::chrono::microseconds(1000000 / fps);
		// Цикл обработки
		auto next_frame = clock::now();

		std::vector<uint8_t> pixels(1024 * 1024 * 4); // RGBA8

		while (m_running) {
			next_frame += frame_time;

			// Заполняем фреймами буфер
			fill_linking_space(space);

			// Устанавливаем viewport
			glViewport(0, 0, 1024, 1024);

			glEnable(GL_DEPTH_TEST);
			glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
			glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

			// Обнолвяем рендер
			render.update_textures(space, m_context_manager->get_display());
			render.update(0.025f);

			render.render(1.0f);

			// Считываем пиксели с FBO
			glReadPixels(0, 0, 1024, 1024, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());

			for (auto& slot : space) {
				slot.reset(); // если slot уже release()-нут — это no-op
			}

			cv::Mat img(1024, 1024, CV_8UC4, pixels.data());
			cv::flip(img, img, 0);

			cv::Mat bgr;
			cv::cvtColor(img, bgr, cv::COLOR_RGBA2BGR);

			writer.write(bgr);

			// Соблюдаем фпс цикла
			std::this_thread::sleep_until(next_frame);
		}

		m_context_manager->undone_current(&m_logger);
	}

	ULinker::NLinkSpace ULinker::create_linking_space() {
		auto space = NLinkSpace{};
		space.resize(m_cameras_purpose.size());

		for (const auto& [key, value] : m_cameras_purpose) {
			auto index = from_bird_camera_type_to_index(key);
			if (index < 0 || index >= space.size()) {
				m_logger.warn("create_linking_space(): index of camera " + from_bird_camera_type_to_string(key) + " out of linking space, skip!");
				continue;
			}
			space[from_bird_camera_type_to_index(key)] = nullptr;
		}

		return space;
	}

	void ULinker::fill_linking_space(NLinkSpace& space) {
		for (auto camera_idx = 0; camera_idx < space.size(); ++camera_idx) {
			EBirdCameraType camera_type;
			if (!from_int_to_bird_camera_type(camera_idx, camera_type)) {
				m_logger.warn("fill_linking_space(): camera idx " + std::to_string(camera_idx) + " invalid!");
				continue;
			}

			// Поиск камеры
			std::string type_string = from_bird_camera_type_to_string(camera_type);
			auto it_camera = m_cameras_purpose.find(camera_type);
			if (it_camera == m_cameras_purpose.end()) {
				m_logger.warn("fill_linking_space(): there is no " + type_string + " camera type at linker!");
				continue;
			}

			// Получение кадра из хранилища
			if (it_camera->second == std::nullopt) {
				m_logger.trace("fill_linking_space(): " + type_string + " is not set at linker, empty!");
				continue;
			}

			auto it_frame = m_storage->extract(it_camera->second.value());
			if (it_frame) {
				m_logger.trace("fill_linking_space(): frame from " + type_string + " camera " + it_camera->second.value() + " moved to Linker");
				space[camera_idx] = std::move(it_frame);
			}
			else {
				m_logger.trace("fill_linking_space(): " + type_string + " camera " + it_camera->second.value() + " did not transmit frames");
				continue;
			}
		}
	}
}; // birdview
}; // varan