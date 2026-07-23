#include "bird-view/linker.h"
#include "bird-view/renderer.h"
#include "bird-view/egl-context.h"

#include "utility/fd-monitor.h"
#include "calibration/constants.h"

#include <boost/json.hpp>
#include <opencv2/opencv.hpp>

namespace calib_consts = varan::calibration::constants;

namespace varan {
namespace birdview {

	ULinker::ULinker(
		const nvr::FWebSocketOptions& websocket,
		UEGLContextManager* manager,
		FFrameStorage<IFrame>* storage,
		uint32_t fps,
		ULogger::ELoggerLevel level
	)
		: m_logger("Bird ULinker", level)
		, m_websocket(websocket)
		, m_storage(storage)
		, m_context_manager(manager)
		, m_exports_root(calib_consts::LINKER_CONFIGURES_ROOT)
		, m_exports_index_json(calib_consts::LINKER_CONFIGURATION_INDEX)
		, m_state_index(calib_consts::LINKER_STATE_INDEX)
		, m_fps(fps)
	{
		reload_from_state();
	}

	ULinker::~ULinker() {
		stop();
	}

	std::filesystem::path ULinker::state_path() const {
		return m_exports_root / m_state_index;
	}

	/*
		Состояние — словарь по export_id:

		{
			"active": "<export_id>",
			"configs": {
				"<export_id>": {
					"cameras": { "<key>": "<camera_id>" | null },
					"fps": 15,
					"stream_id": "...",
					"stream_name": "..."
				}
			}
		}

		Старый формат из одной записи { export_id, cameras } читается и
		приводится к этому виду: иначе обновление потеряло бы уже настроенные
		привязки, а их набивают руками по шесть камер.
	*/
	boost::json::object ULinker::read_state_root() const {
		boost::json::object empty;
		empty["active"] = "";
		empty["configs"] = boost::json::object();

		const auto path = state_path();
		if (!std::filesystem::exists(path)) return empty;

		try {
			std::ifstream f(path);
			std::stringstream ss; ss << f.rdbuf();
			auto v = boost::json::parse(ss.str());
			if (!v.is_object()) return empty;

			auto root = v.as_object();

			// Уже новый формат
			if (root.contains("configs") && root.at("configs").is_object()) {
				if (!root.contains("active")) root["active"] = "";
				return root;
			}

			// Старый формат: одна активная запись
			std::string old_id;
			if (auto* eid = root.if_contains("export_id"); eid && eid->is_string()) {
				old_id = eid->as_string().c_str();
			}
			if (old_id.empty()) return empty;

			boost::json::object entry;
			if (auto* cams = root.if_contains("cameras"); cams && cams->is_object()) {
				entry["cameras"] = *cams;
			}
			else {
				entry["cameras"] = boost::json::object();
			}

			boost::json::object configs;
			configs[old_id] = std::move(entry);

			boost::json::object migrated;
			migrated["active"] = old_id;
			migrated["configs"] = std::move(configs);
			return migrated;
		}
		catch (const std::exception& e) {
			m_logger.error("read_state_root(): " + std::string(e.what()));
			return empty;
		}
	}

	bool ULinker::reload_from_state() {
		auto root = read_state_root();

		std::string export_id_from_state;
		if (auto* a = root.if_contains("active"); a && a->is_string()) {
			export_id_from_state = a->as_string().c_str();
		}
		if (export_id_from_state.empty()) {
			m_logger.warn("reload_from_state(): no active configuration");
			return false;
		}

		const auto& configs = root.at("configs").as_object();
		auto it = configs.find(export_id_from_state);
		if (it == configs.end() || !it->value().is_object()) {
			m_logger.warn("reload_from_state(): no entry for <" + export_id_from_state + ">");
			return false;
		}
		const auto& entry = it->value().as_object();

		NCamerasPurpose desired;
		if (auto* cams = entry.if_contains("cameras"); cams && cams->is_object()) {
			for (const auto& [k, val] : cams->as_object()) {
				if (val.is_string()) {
					desired[std::string(k)] = std::string(val.as_string().c_str());
				}
				else {
					desired[std::string(k)] = std::nullopt;
				}
			}
		}

		FStreamParams params;
		if (auto* v = entry.if_contains("fps"); v && v->is_int64()) {
			params.fps = static_cast<uint32_t>(v->as_int64());
		}
		if (auto* v = entry.if_contains("stream_id"); v && v->is_string()) {
			params.stream_id = v->as_string().c_str();
		}
		if (auto* v = entry.if_contains("stream_name"); v && v->is_string()) {
			params.stream_name = v->as_string().c_str();
		}

		{
			std::lock_guard<std::mutex> lk(m_mutex);
			m_params = params;
		}

		return apply_export(export_id_from_state, std::move(desired));
	}

	ULinker::FStreamParams ULinker::get_stream_params() const {
		std::lock_guard<std::mutex> lk(m_mutex);
		FStreamParams out = m_params;
		if (out.fps == 0) out.fps = m_fps;
		if (out.stream_id.empty()) out.stream_id = constants::VIRTUAL_CAMERA_ID;
		return out;
	}

	std::string ULinker::get_stream_name() const {
		std::lock_guard<std::mutex> lk(m_mutex);
		return m_params.stream_name;
	}

	bool ULinker::apply_export(const std::string& export_id, NCamerasPurpose desired_bindings) {
		// Достаём камеры из JSON-индекса экспорта — это правда о ключах.
		auto linker_configures = m_exports_root / m_exports_index_json;
		std::ifstream f(linker_configures);
		if (!f.is_open()) {
			m_logger.error("apply_export(): cannot open " + linker_configures.string());
			return false;
		}
		std::stringstream ss; ss << f.rdbuf();
		boost::json::value v;
		try { 
			v = boost::json::parse(ss.str()); 
		}
		catch (...) {
			m_logger.error("apply_export(): json parse error");
			return false;
		}
		if (!v.is_object() || !v.as_object().contains(export_id)) {
			m_logger.error("apply_export(): export <" + export_id + "> not found in index");
			return false;
		}
		const auto& obj = v.as_object().at(export_id).as_object();
		const auto& cams = obj.at("cameras").as_object();

		// Собираем итоговый purpose: ключи берутся из JSON-индекса,
		// значения — из save-файла (если там есть, иначе nullopt).
		std::lock_guard<std::mutex> lk(m_mutex);
		m_export_id = export_id;
		m_camera_keys.clear();
		m_cameras_purpose.clear();

		for (const auto& [k, _] : cams) {
			std::string key(k);
			auto it = desired_bindings.find(key);
			m_cameras_purpose[key] = (it != desired_bindings.end()) ? it->second : std::nullopt;
			m_camera_keys.push_back(std::move(key));
		}

		int bound = 0;
		for (auto& [k, val] : m_cameras_purpose) if (val.has_value()) ++bound;

		m_logger.info("apply_export(): <" + export_id + ">, " +
			std::to_string(m_cameras_purpose.size()) + " keys, " +
			std::to_string(bound) + " bound to cameras");
		return true;
	}

	std::vector<ULinker::FExportInfo> ULinker::list_exports() {
		std::vector<FExportInfo> result;
		try {
			auto list_confihuration_file_path = calib_consts::LINKER_CONFIGURES_ROOT / calib_consts::LINKER_CONFIGURATION_INDEX; 
			if (!std::filesystem::exists(list_confihuration_file_path)) return result;

			std::ifstream f(list_confihuration_file_path);
			std::stringstream ss; ss << f.rdbuf();
			auto v = boost::json::parse(ss.str());
			if (!v.is_object()) return result;

			for (const auto& [id, val] : v.as_object()) {
				if (!val.is_object()) continue;
				const auto& obj = val.as_object();

				FExportInfo info;
				info.id = id;
				if (auto* name = obj.if_contains("name"); name && name->is_string()) {
					info.name = name->as_string().c_str();
				}
				else {
					info.name = info.id;
				}
				if (auto* cams = obj.if_contains("cameras"); cams && cams->is_object()) {
					for (const auto& [k, _] : cams->as_object()) {
						info.cameras.emplace_back(k);
					}
				}
				result.push_back(std::move(info));
			}
		}
		catch (const std::exception& e) {
			 m_logger.error("list_exports(): " + std::string(e.what()));
		}
		return result;
	}

	boost::json::object ULinker::get_state_raw() {
		// Читаем тем же путём, что и reload_from_state(): раньше здесь стояло
		// голое m_state_index, то есть путь относительно рабочего каталога,
		// и ручка состояния почти всегда отдавала пустоту
		return read_state_root();
	}

	bool ULinker::write_state(
		const std::string& export_id,
		const std::unordered_map<std::string, std::string>& bindings,
		const FStreamParams& params)
	{
		if (export_id.empty()) {
			m_logger.error("write_state(): empty export_id");
			return false;
		}
		try {
			auto root = read_state_root();
			auto configs = root.at("configs").as_object();

			boost::json::object entry;
			boost::json::object cams;
			for (const auto& [k, v] : bindings) {
				if (v.empty()) cams[k] = nullptr;
				else           cams[k] = v;
			}
			entry["cameras"] = std::move(cams);
			if (params.fps > 0) entry["fps"] = static_cast<int64_t>(params.fps);
			if (!params.stream_id.empty()) entry["stream_id"] = params.stream_id;
			if (!params.stream_name.empty()) entry["stream_name"] = params.stream_name;

			configs[export_id] = std::move(entry);

			root["configs"] = std::move(configs);
			root["active"] = export_id;

			std::filesystem::create_directories(m_exports_root);
			std::ofstream f(state_path());
			f << boost::json::serialize(root);
		}
		catch (const std::exception& e) {
			m_logger.error("write_state(): " + std::string(e.what()));
			return false;
		}

		m_logger.info("write_state(): persisted, export_id=" + export_id);
		return reload_from_state();
	}

	bool ULinker::delete_export(const std::string& export_id, std::string& error) {
		if (export_id.empty()) {
			error = "empty export_id";
			return false;
		}

		// Каталог карт читает работающий поток, снести его из-под него нельзя
		if (m_running.load() && get_active_export_id() == export_id) {
			error = "configuration <" + export_id + "> is running, stop the output first";
			return false;
		}

		// id уходит в путь: допускаем только то же, что пропускает handle_save_lut
		for (char c : export_id) {
			const bool ok = (c >= 'a' && c <= 'z')
				|| (c >= 'A' && c <= 'Z')
				|| (c >= '0' && c <= '9')
				|| c == '_' || c == '-';
			if (!ok) {
				error = "id contains invalid characters";
				return false;
			}
		}

		try {
			// 1) Запись в индексе экспортов
			const auto index_path = m_exports_root / m_exports_index_json;
			if (std::filesystem::exists(index_path)) {
				std::ifstream f(index_path);
				std::stringstream ss; ss << f.rdbuf();
				f.close();

				auto v = boost::json::parse(ss.str());
				if (v.is_object()) {
					auto root = v.as_object();
					if (!root.contains(export_id)) {
						error = "export <" + export_id + "> not found";
						return false;
					}
					root.erase(export_id);
					std::ofstream out(index_path);
					out << boost::json::serialize(root);
				}
			}
			else {
				error = "exports index not found";
				return false;
			}

			// 2) Каталог с картами remap и weight
			const auto dir = m_exports_root / export_id;
			if (std::filesystem::exists(dir)) {
				std::filesystem::remove_all(dir);
			}

			// 3) Привязки и параметры этой конфигурации
			auto state = read_state_root();
			auto configs = state.at("configs").as_object();
			configs.erase(export_id);

			std::string active;
			if (auto* a = state.if_contains("active"); a && a->is_string()) {
				active = a->as_string().c_str();
			}
			if (active == export_id) state["active"] = "";

			state["configs"] = std::move(configs);
			std::ofstream sf(state_path());
			sf << boost::json::serialize(state);
		}
		catch (const std::exception& e) {
			error = e.what();
			m_logger.error("delete_export(): " + error);
			return false;
		}

		{
			std::lock_guard<std::mutex> lk(m_mutex);
			if (m_export_id == export_id) {
				m_export_id.clear();
				m_camera_keys.clear();
				m_cameras_purpose.clear();
				m_params = FStreamParams{};
			}
		}

		m_logger.info("delete_export(): removed <" + export_id + ">");
		return true;
	}

	ULinker::NLinkSpace ULinker::create_linking_space() {
		NLinkSpace space;
		space.resize(m_camera_keys.size());
		return space;
	}

	void ULinker::fill_linking_space(NLinkSpace& space) {
		std::lock_guard<std::mutex> lk(m_mutex);
		for (size_t i = 0; i < m_camera_keys.size(); ++i) {
			const auto& key = m_camera_keys[i];
			auto it = m_cameras_purpose.find(key);
			if (it == m_cameras_purpose.end() || !it->second.has_value()) {
				space[i] = nullptr;
				continue;
			}
			auto frame = m_storage->extract(*it->second);
			if (frame) {
				space[i] = std::move(frame);
			}
		}
	}

	std::vector<std::string> ULinker::get_camera_keys() const {
		std::lock_guard<std::mutex> lk(m_mutex);
		return m_camera_keys;
	}

	std::string ULinker::get_stream_id() const {
		return m_stream_id;
	}

	std::string ULinker::get_active_export_id() const {
		std::lock_guard<std::mutex> lk(m_mutex);
		return m_export_id;
	}

	bool ULinker::set_render_camera(const std::string& key, std::string camera) {
		auto it_camera = m_cameras_purpose.find(key);
		if (it_camera == m_cameras_purpose.end()) {
			m_logger.error("set_render_camera(): there is no camera <" + key + "> at linker!");
			return false;
		}

		it_camera->second = camera;
		m_logger.debug("set_render_camera(): setting <" + key + "> camera to " + camera);
		return true;
	}

	bool ULinker::restart() {
		if (m_running) stop();
		if (!reload_from_state()) {
			m_logger.error("restart(): no valid state");
			return false;
		}
		return async_start();
	}

	bool ULinker::async_start() {
		{
			std::lock_guard<std::mutex> lk(m_mutex);
			if (m_export_id.empty()) {
				m_logger.error("async_start(): no active export — call reload_from_state() first");
				return false;
			}
		}
		if (m_running.exchange(true)) {
			m_logger.warn("async_start(): already running");
			return true;
		}
		// TO DO: заменть это говноа на условуню переменную
		m_worker = std::thread([this] {
			while (m_running.load()) {
				processing_loop(m_fps);
				m_logger.warn("processing stream ended!");
				if (m_running.load()) {
					std::this_thread::sleep_for(std::chrono::seconds(5));
				}
			}
		});
		return true;
	}

	void ULinker::stop() {
		if (!m_running.exchange(false)) return;
		if (m_worker.joinable()) m_worker.join();
	}

	void ULinker::processing_loop(uint32_t fps) {
		using clock = std::chrono::high_resolution_clock;

		if (!m_context_manager || !m_context_manager->make_current(&m_logger)) {
			m_logger.error("processing_loop(): cannot make context current");
			return;
		}

		UStitchRenderer renderer;
		if (!renderer.init(0, m_context_manager, &m_logger)) {
			m_logger.error("processing_loop(): renderer init failed");
			return;
		}

		std::string export_id_copy;
		{ std::lock_guard<std::mutex> lk(m_mutex); export_id_copy = m_export_id; }

		if (export_id_copy.empty() ||
			!renderer.load_export(m_exports_root, m_exports_index_json, export_id_copy))
		{
			m_logger.error("processing_loop(): no active export, abort");
			return;
		}

		const int W = renderer.canvas_width();
		const int H = renderer.canvas_height();

		const bool rotate = H > W;
		renderer.set_rotate_ccw(rotate);

		const int outW = rotate ? H : W;
		const int outH = rotate ? W : H;

		m_logger.info("processing_loop(): src=" + std::to_string(W) + "x" + std::to_string(H) +
			", out=" + std::to_string(outW) + "x" + std::to_string(outH) +
			", rotate=" + (rotate ? "true" : "false"));

		if (!m_context_manager->init_render_framebuffer(outW, outH, &m_logger)) {
			m_logger.error("processing_loop(): cannot init render FBO");
			return;
		}

		//cv::VideoWriter writer;
		//writer.open("/home/orangepi/render/output.avi",
		//	cv::VideoWriter::fourcc('M', 'J', 'P', 'G'),
		//	fps, cv::Size(W, H));

		// Проверка вебсокета
		if (m_websocket.ip_adress.empty() || m_websocket.port.empty()) {
			m_logger.error("processing_loop(): websocket is incorrect, aborted starting connection!");
			return;
		}

		// Запуск вирутальной камеры. Идентификатор и частота берутся из настроек
		// активной конфигурации; без них остаются прежние значения по умолчанию
		const auto params = get_stream_params();
		m_stream_id = params.stream_id;
		fps = params.fps;

		m_streamer = std::make_unique<neural::UVirtualCamera>(m_stream_id, m_websocket);
		if (!m_streamer) {
			m_logger.error("processing_loop(): streamer didn't create");
			return;
		}
		if (!m_streamer->set_parameters(outW, outH, fps)) {
			m_logger.error("processing_loop(): streamer set_parameters failed");
			return;
		}
		if (!m_streamer->initialize()) {
			m_logger.error("processing_loop(): streamer initialize failed");
			return;
		}
		if (!m_streamer->start()) {
			m_logger.error("processing_loop(): streamer start failed");
			return;
		}
		m_logger.info("processing_loop(): streamer started, stream_id=" + m_stream_id);

		std::vector<uint8_t> pixels(static_cast<size_t>(outW) * outH * 4);

		// Синхронизируем порядок ключей с тем, что вернул рендерер.
		{
			std::lock_guard<std::mutex> lk(m_mutex);
			m_camera_keys = renderer.ordered_camera_keys();
		}

		const auto frame_time = std::chrono::microseconds(1000000 / fps);
		auto next_frame = clock::now();
		auto space = create_linking_space();

		while (m_running) {
			next_frame += frame_time;

			fill_linking_space(space);

			renderer.update_textures(space, m_context_manager->get_display());
			renderer.update(0.0f);
			renderer.render(1.0f);

			glReadPixels(0, 0, outW, outH, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());

			cv::Mat img(outH, outW, CV_8UC4, pixels.data());
			//cv::flip(img, img, 0);
			//cv::Mat bgr;
			//cv::cvtColor(img, bgr, cv::COLOR_RGBA2BGR);
			//if (writer.isOpened()) writer.write(bgr);

			if (m_streamer) m_streamer->push_frame(img);

			std::this_thread::sleep_until(next_frame);
		}

		if (m_streamer) {
			m_streamer->stop_websocket_client();
			m_streamer->stop();
			m_streamer.reset();
		}

		m_context_manager->undone_current(&m_logger);
	}

	std::filesystem::path ULinker::get_configurations_path() {
		return constants::LINKER_CONFIGURATIONS;
	}

	std::filesystem::path ULinker::get_exports_index_path() const {
		return m_exports_root / m_exports_index_json;
	}

	std::filesystem::path ULinker::get_images_list_path() {
		return constants::LINKER_IMAGES_PATH;
	}

	/*
	void ULinker::processing_cube_loop(uint32_t fps)
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
	*/
}; // birdview
}; // varan