#include "correction-extension.h"

#include <algorithm>
#include <fstream>
#include <future>

#include "signaling_definers.h"
#include "core/paths.h"
#include "calibration/constants.h"
#include "calibration/utility.h"
#include "utility/json-definers.h"

namespace varan {
namespace neural {

	static constexpr int DEFAULT_CORRECTION_FPS = 15;
	static constexpr int MIN_CORRECTION_FPS = 1;
	static constexpr int MAX_CORRECTION_FPS = 60;

	UCorrectionExtension::UCorrectionExtension(
		std::string camera_id,
		FFrameStorage<IFrame>* storage,
		birdview::UEGLContextManager* gl_manager,
		CModuleReply reply,
		std::function<void(std::string)> send_callback,
		ULogger::ELoggerLevel level
	)
		: m_camera_id(std::move(camera_id))
		, m_storage(storage)
		, m_gl_manager(gl_manager)
		, m_reply(std::move(reply))
		, m_send_callback(std::move(send_callback))
		, m_logger(m_camera_id + ": correction", level)
	{}

	UCorrectionExtension::~UCorrectionExtension() {
		if (m_correction_thread.joinable()) {
			m_correction_thread.join();
		}
		destroy_correction(true);
	}

	bool UCorrectionExtension::handle_message(
		const std::string& client_id,
		const std::string& type,
		const boost::json::object& message
	) {
		if (type != "correction") {
			return false;
		}

		bool enable = false;
		if (auto* m = message.if_contains(SIG_META); m && m->is_object()) {
			if (auto* e = m->as_object().if_contains("enable"); e && e->is_bool()) {
				enable = e->as_bool();
			}
		}

		auto reply = [this, client_id, type](bool ok, const std::string& description) {
			ok ? m_logger.info(description) : m_logger.error(description);
			m_reply(client_id, ok, type, description);
		};

		if (!enable) {
			// Выключение — клиент переподключится на обычный поток,
			// пайплайн умрёт с его сессией
			reply(true, "Correction disabled");
			return true;
		}

		{
			std::lock_guard<std::mutex> lock(m_correction_mutex);
			if (m_correction) {
				reply(true, "Correction pipeline is ready");
				return true;
			}
		}

		if (m_correction_building.exchange(true)) {
			reply(false, "Correction pipeline is already being created");
			return true;
		}

		if (m_correction_thread.joinable()) {
			m_correction_thread.join();
		}

		// Создание тяжёлое (карты, EGL, gstreamer) — не держим поток вебсокета
		m_correction_thread = std::thread([this, reply]() {
			std::string error;
			const bool ok = build_correction_pipeline(error);
			m_correction_building = false;
			reply(ok, ok ? "Correction pipeline is ready" : error);
		});

		return true;
	}

	FStreamClaim UCorrectionExtension::select_stream(
		const std::string& client_id,
		const std::string& type,
		const boost::json::object& message
	) {
		std::lock_guard<std::mutex> lock(m_correction_mutex);

		if (type == SIG_TYPE_CONNECT) {
			bool wanted = false;

			if (auto* v = message.if_contains(rest::fields::STREAM); v && v->is_string()) {
				wanted = (v->as_string().c_str() == STREAM_KEY);
			}
			// Легаси-флаг старого плеера 360, живёт до шага уборки
			if (auto* v = message.if_contains("correction"); v && v->is_bool() && v->as_bool()) {
				wanted = true;
			}

			// Просили коррекцию, а пайплайна нет — заявка с пустым потоком,
			// камера ответит ошибкой вместо подмены
			if (wanted) {
				return { true, m_correction.get() };
			}

			return {};
		}

		// Продолжение уже установленной сессии
		if (m_correction && m_correction->has_webrtc_session(client_id)) {
			return { true, m_correction.get() };
		}

		return {};
	}

	void UCorrectionExtension::on_session_closed(const std::string& client_id, UCameraPipeline* stream) {
		// Чужие close (клиент сидел на обычном потоке) не должны убивать свежесозданный
		// пайплайн, который ещё ждёт своего первого подключения
		bool destroy = false;
		{
			std::lock_guard<std::mutex> lock(m_correction_mutex);
			destroy = m_correction && stream == m_correction.get()
				&& m_correction->webrtc_session_count() == 0;
		}
		if (destroy) {
			m_logger.info("on_session_closed(): last correction viewer left, destroying correction pipeline");
			destroy_correction(false);
		}
	}

	bool UCorrectionExtension::build_correction_pipeline(std::string& error) {
		namespace calib = varan::calibration;

		if (!m_storage || !m_gl_manager) {
			error = "Correction pipeline is unavailable: no frame storage or GL context";
			return false;
		}

		// 1. Сопоставление камеры и конфигурации.
		// Запись — объект {config, fps}; строка — легаси-формат без fps
		std::string config_key;
		int fps = DEFAULT_CORRECTION_FPS;
		{
			std::ifstream file(varan::paths().surround.calibration_links);
			if (file.is_open()) {
				try {
					std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
					auto parsed = boost::json::parse(content);
					if (parsed.is_object()) {
						if (auto* v = parsed.as_object().if_contains(m_camera_id)) {
							if (v->is_string()) {
								config_key = v->as_string().c_str();
							}
							else if (v->is_object()) {
								const auto& link = v->as_object();
								if (auto* c = link.if_contains("config"); c && c->is_string()) {
									config_key = c->as_string().c_str();
								}
								if (auto* f = link.if_contains("fps"); f && f->is_number()) {
									fps = std::clamp(boost::json::value_to<int>(*f),
										MIN_CORRECTION_FPS, MAX_CORRECTION_FPS);
								}
							}
						}
					}
				}
				catch (const std::exception& e) {
					m_logger.warn("build_correction_pipeline(): broken links.json: " + std::string(e.what()));
				}
			}
		}
		if (config_key.empty()) {
			error = "Camera is not linked to any calibration configuration";
			return false;
		}

		// 2. Конфигурация калибровки с undist-картами
		int width = 0;
		int height = 0;
		std::string map_x_name;
		std::string map_y_name;
		{
			std::ifstream file(varan::paths().surround.calibration_settings);
			if (!file.is_open()) {
				error = "Calibration configurations file not found";
				return false;
			}
			try {
				std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
				auto root = boost::json::parse(content).as_object();
				auto* entry = root.if_contains(config_key);
				if (!entry || !entry->is_object()) {
					error = "Calibration configuration <" + config_key + "> not found";
					return false;
				}
				const auto& obj = entry->as_object();
				width = boost::json::value_to<int>(obj.at(calib::constants::JSON_WIDTH));
				height = boost::json::value_to<int>(obj.at(calib::constants::JSON_HEIGHT));

				auto* mx = obj.if_contains(calib::constants::JSON_UNDISTORTION_MAP_X);
				auto* my = obj.if_contains(calib::constants::JSON_UNDISTORTION_MAP_Y);
				if (!mx || !my || !mx->is_string() || !my->is_string()) {
					error = "Calibration <" + config_key + "> has no correction maps";
					return false;
				}
				map_x_name = mx->as_string().c_str();
				map_y_name = my->as_string().c_str();
			}
			catch (const std::exception& e) {
				error = "Cannot read calibration configuration: " + std::string(e.what());
				return false;
			}
		}

		// 3. Файлы карт на диске
		cv::Mat map_x;
		cv::Mat map_y;
		const auto maps_dir = varan::paths().surround.calibration_maps;
		if (!calib::utility::SBinary::load_mat_from_binary(maps_dir / map_x_name, map_x, &m_logger)
			|| !calib::utility::SBinary::load_mat_from_binary(maps_dir / map_y_name, map_y, &m_logger)) {
			error = "Correction map files not found or broken";
			return false;
		}

		// Калибратор печёт карты в CV_16SC2 (fixed-point) — шейдеру нужны float-координаты
		if (map_x.type() != CV_32FC1 || map_y.type() != CV_32FC1) {
			cv::Mat float_x;
			cv::Mat float_y;
			try {
				cv::convertMaps(map_x, map_y, float_x, float_y, CV_32FC1);
			}
			catch (const cv::Exception& e) {
				error = "Correction maps have an unsupported format";
				m_logger.error("build_correction_pipeline(): convertMaps: " + std::string(e.what()));
				return false;
			}
			map_x = std::move(float_x);
			map_y = std::move(float_y);
		}

		// 4. Живой кадр и совпадение разрешений
		auto frame = m_storage->extract(m_camera_id);
		if (!frame) {
			error = "No live frame from the camera: the stream with birdview purpose is not running";
			return false;
		}
		if (static_cast<int>(frame->width) != width || static_cast<int>(frame->height) != height) {
			error = "Calibration doesn't match the stream resolution: calibration "
				+ std::to_string(width) + "x" + std::to_string(height)
				+ ", stream " + std::to_string(frame->width) + "x" + std::to_string(frame->height);
			return false;
		}

		// 5. Сборка и запуск
		FPipelineConfig config;
		config.name = STREAM_KEY;
		config.camera_name = m_camera_id;
		config.type = EPilelineType::CORRECTION;
		config.purposes.add(EStreamPurpose::VIEW);

		auto pipe_logger = std::make_unique<ULogger>(m_camera_id + ": correction", m_logger.get_level());

		auto pipeline = std::make_unique<UCorrectionPipeline>(
			config,
			std::move(pipe_logger),
			m_send_callback,
			m_gl_manager,
			m_storage
		);

		if (!pipeline->set_maps(std::move(map_x), std::move(map_y), width, height, fps, error)) {
			return false;
		}
		if (!pipeline->initialize()) {
			error = "Cannot initialize the correction pipeline";
			return false;
		}
		if (!pipeline->start()) {
			error = "Cannot start the correction pipeline";
			return false;
		}

		std::lock_guard<std::mutex> lock(m_correction_mutex);
		m_correction = std::move(pipeline);
		return true;
	}

	void UCorrectionExtension::destroy_correction(bool wait) {
		std::unique_ptr<UCorrectionPipeline> victim;
		{
			std::lock_guard<std::mutex> lock(m_correction_mutex);
			victim = std::move(m_correction);
		}
		if (!victim) return;

		// Разбор gst-пайплайна — на потоке GMainLoop, как в UCamera::stop()
		struct FDestroyCtx {
			std::unique_ptr<UCorrectionPipeline> pipeline;
			std::shared_ptr<std::promise<void>> done;
		};

		auto done = std::make_shared<std::promise<void>>();
		auto* ctx = new FDestroyCtx{ std::move(victim), done };

		g_main_context_invoke(nullptr,
			+[](gpointer data) -> gboolean {
				auto* ctx = static_cast<FDestroyCtx*>(data);
				ctx->pipeline.reset();
				ctx->done->set_value();
				delete ctx;
				return G_SOURCE_REMOVE;
			},
			ctx
		);

		if (wait) {
			auto future = done->get_future();
			if (future.wait_for(std::chrono::seconds(5)) == std::future_status::timeout) {
				m_logger.error("destroy_correction(): teardown timeout");
			}
		}
	}

} // namespace neural
} // namespace varan
