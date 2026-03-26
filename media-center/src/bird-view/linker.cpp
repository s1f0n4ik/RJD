#include "bird-view/linker.h"
#include "bird-view/renderer.h"
#include "bird-view/egl-context.h"

namespace varan {
namespace birdview {

	ULinker::ULinker(
		const nvr::FWebSocketOptions& websocket,
		ULogger::ELoggerLevel level
	)
		: m_logger("Bird ULinker", level)
		, m_storage(&m_logger)
	{
	}



	ULinker::~ULinker() {
		stop();
	}

	CDmabufMover ULinker::get_dmabuf_frame_callback() {
		return std::move(m_storage.get_callback());
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
		using clock = std::chrono::high_resolution_clock;
		// Использование контекста
		auto context = FEGLContext();
		context.init(&m_logger);
		// инициализация ренждера
		auto render = UCubeRenderer();
		if (render.init(m_cameras_purpose.size(), &m_logger) == false) {
			m_logger.error("processing_loop(): render didn;t initialize, abort linking loop!");
			return;
		}
		// получаем время кадра
		const auto frame_time = std::chrono::microseconds(1000000 / fps);
		// Собираем хранилище для кажров
		auto space = create_linking_space();
		// Цикл обработки
		auto next_frame = clock::now();
		while (m_running) {
			next_frame += frame_time;

			// Заполняем фреймами буфер
			fill_linking_space(space);

			// Обнолвяем рендер
			render.update_textures(space, context.display);
			render.update(0.1f);

			render.render(1.0f);

			// Соблюдаем фпс цикла
			std::this_thread::sleep_until(next_frame);
		}
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
			space[from_bird_camera_type_to_index(key)] = std::nullopt;
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

			auto it_frame = m_storage.extract(it_camera->second.value());
			if (it_frame == std::nullopt) {
				m_logger.trace("fill_linking_space(): " + type_string + " camera " + it_camera->second.value() + " did not transmit frames");
				continue;
			}
			else {
				m_logger.trace("fill_linking_space(): frame from " + type_string + " camera " + it_camera->second.value() + " moved to Linker");
				space[camera_idx] = std::move(it_frame);
			}
		}
	}
}; // birdview
}; // varan