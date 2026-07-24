#include "bird-view/linker.h"
#include "bird-view/renderer.h"
#include "bird-view/surround-renderer.h"
#include "bird-view/surround-bake.h"
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
		, m_state_root(calib_consts::LINKER_STATE_ROOT)
		, m_state_index(calib_consts::LINKER_STATE_INDEX)
		, m_fps(fps)
	{
		reload_from_state();
	}

	ULinker::~ULinker() {
		stop();
	}

	std::filesystem::path ULinker::state_path() const {
		return m_state_root / m_state_index;
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
		if (auto* v = entry.if_contains("rotation"); v && v->is_int64()) {
			const int degrees = static_cast<int>(v->as_int64());
			if (is_valid_rotation(degrees)) params.rotation = degrees;
			else m_logger.warn("reload_from_state(): bad rotation " + std::to_string(degrees));
		}
		if (auto* v = entry.if_contains("view_mode"); v && v->is_string()) {
			const std::string mode = v->as_string().c_str();
			if (is_valid_view_mode(mode)) params.view_mode = mode;
			else m_logger.warn("reload_from_state(): bad view_mode " + mode);
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

	int ULinker::resolve_rotation(const std::string& export_id) const {
		std::string target = export_id;
		int stored = -1;
		{
			std::lock_guard<std::mutex> lk(m_mutex);
			if (target.empty()) target = m_export_id;
			if (target == m_export_id) stored = m_params.rotation;
		}

		if (is_valid_rotation(stored)) return stored;
		if (target.empty()) return 0;

		/*
			Угол активной конфигурации уже лежит в m_params, а про остальные
			спрашивают статус и ручка экспорта — им приходится читать состояние.
			Ничего не нашлось — 0: раньше здесь угол выводился из формы канваса,
			и это правило годами прятало падение на невыровненной ширине.
		*/
		try {
			auto root = read_state_root();
			auto* configs = root.if_contains("configs");
			if (!configs || !configs->is_object()) return 0;

			auto* entry = configs->as_object().if_contains(target);
			if (!entry || !entry->is_object()) return 0;

			auto* v = entry->as_object().if_contains("rotation");
			if (!v || !v->is_int64()) return 0;

			const int degrees = static_cast<int>(v->as_int64());
			return is_valid_rotation(degrees) ? degrees : 0;
		}
		catch (const std::exception& e) {
			m_logger.warn("resolve_rotation(): " + std::string(e.what()));
			return 0;
		}
	}

	std::string ULinker::resolve_view_mode(const std::string& export_id) const {
		std::string target = export_id;
		std::string stored;
		{
			std::lock_guard<std::mutex> lk(m_mutex);
			if (target.empty()) target = m_export_id;
			if (target == m_export_id) stored = m_params.view_mode;
		}

		if (is_valid_view_mode(stored)) return stored;
		if (target.empty()) return "top";

		// Про неактивные конфигурации спрашивает статус, им читается состояние
		try {
			auto root = read_state_root();
			auto* configs = root.if_contains("configs");
			if (!configs || !configs->is_object()) return "top";

			auto* entry = configs->as_object().if_contains(target);
			if (!entry || !entry->is_object()) return "top";

			auto* v = entry->as_object().if_contains("view_mode");
			if (!v || !v->is_string()) return "top";

			const std::string mode = v->as_string().c_str();
			return is_valid_view_mode(mode) ? mode : "top";
		}
		catch (const std::exception& e) {
			m_logger.warn("resolve_view_mode(): " + std::string(e.what()));
			return "top";
		}
	}

	std::pair<int, int> ULinker::get_output_size() const {
		std::lock_guard<std::mutex> lk(m_mutex);
		return { m_out_width, m_out_height };
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

			/*
				Запись правится, а не собирается заново.

				Собранная с нуля теряет всё, чего не передали в этом вызове.
				Так пропадал поворот: его писала своя ручка, а следующее
				сохранение привязок затирало запись целиком.
			*/
			boost::json::object entry;
			if (auto* prev = configs.if_contains(export_id); prev && prev->is_object()) {
				entry = prev->as_object();
			}

			boost::json::object cams;
			for (const auto& [k, v] : bindings) {
				if (v.empty()) cams[k] = nullptr;
				else           cams[k] = v;
			}
			entry["cameras"] = std::move(cams);
			if (params.fps > 0) entry["fps"] = static_cast<int64_t>(params.fps);
			if (!params.stream_id.empty()) entry["stream_id"] = params.stream_id;
			if (!params.stream_name.empty()) entry["stream_name"] = params.stream_name;
			if (is_valid_rotation(params.rotation)) entry["rotation"] = params.rotation;
			if (is_valid_view_mode(params.view_mode)) entry["view_mode"] = params.view_mode;

			configs[export_id] = std::move(entry);

			root["configs"] = std::move(configs);
			root["active"] = export_id;

			std::filesystem::create_directories(m_state_root);
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

	bool ULinker::set_rotation(const std::string& export_id, int degrees, std::string& error) {
		if (!is_valid_rotation(degrees)) {
			error = "rotation must be one of 0, 90, 180, 270";
			return false;
		}

		std::string target = export_id.empty() ? get_active_export_id() : export_id;
		if (target.empty()) {
			error = "no active configuration and no export_id given";
			return false;
		}

		// Пишем в состояние
		try {
			auto root = read_state_root();
			auto configs = root.at("configs").as_object();

			boost::json::object entry;
			if (auto* prev = configs.if_contains(target); prev && prev->is_object()) {
				entry = prev->as_object();
			}
			entry["rotation"] = degrees;
			configs[target] = std::move(entry);

			root["configs"] = std::move(configs);

			std::filesystem::create_directories(m_state_root);
			std::ofstream f(state_path());
			f << boost::json::serialize(root);
		}
		catch (const std::exception& e) {
			error = e.what();
			m_logger.error("set_rotation(): " + error);
			return false;
		}

		{
			std::lock_guard<std::mutex> lk(m_mutex);
			if (m_export_id == target) m_params.rotation = degrees;
		}

		m_logger.info("set_rotation(): <" + target + "> -> " + std::to_string(degrees));

		/*
			Живой вывод пересобираем: при 90 и 270 стороны меняются местами,
			а размер задан пайплайну при создании. Менять его на ходу нельзя.
		*/
		if (m_running.load() && get_active_export_id() == target) {
			m_logger.info("set_rotation(): restarting output to apply new size");
			if (!restart()) {
				error = "rotation saved, but output restart failed";
				return false;
			}
		}

		return true;
	}

	bool ULinker::set_view_mode(const std::string& export_id, const std::string& mode, std::string& error) {
		if (!is_valid_view_mode(mode)) {
			error = "view_mode must be one of: top, surround";
			return false;
		}

		std::string target = export_id.empty() ? get_active_export_id() : export_id;
		if (target.empty()) {
			error = "no active configuration and no export_id given";
			return false;
		}

		try {
			auto root = read_state_root();
			auto configs = root.at("configs").as_object();

			boost::json::object entry;
			if (auto* prev = configs.if_contains(target); prev && prev->is_object()) {
				entry = prev->as_object();
			}
			entry["view_mode"] = mode;
			configs[target] = std::move(entry);

			root["configs"] = std::move(configs);

			std::filesystem::create_directories(m_state_root);
			std::ofstream f(state_path());
			f << boost::json::serialize(root);
		}
		catch (const std::exception& e) {
			error = e.what();
			m_logger.error("set_view_mode(): " + error);
			return false;
		}

		{
			std::lock_guard<std::mutex> lk(m_mutex);
			if (m_export_id == target) m_params.view_mode = mode;
		}

		m_logger.info("set_view_mode(): <" + target + "> -> " + mode);

		// Размер кадра у режимов разный, живой вывод пересобирается
		if (m_running.load() && get_active_export_id() == target) {
			m_logger.info("set_view_mode(): restarting output to apply new mode");
			if (!restart()) {
				error = "view_mode saved, but output restart failed";
				return false;
			}
		}

		return true;
	}

	bool ULinker::set_surround_camera(const std::string& export_id, const std::string& place_key,
		const boost::json::object& payload, std::string& error)
	{
		std::string target = export_id.empty() ? get_active_export_id() : export_id;
		if (target.empty() || place_key.empty()) {
			error = "export_id and place_key are required";
			return false;
		}

		bool reset = false;
		if (auto* v = payload.if_contains("reset"); v && v->is_bool()) reset = v->as_bool();

		if (!reset) {
			auto* pos = payload.if_contains("position");
			if (!pos || !pos->is_array() || pos->as_array().size() != 3) {
				error = "position must be [x,y,z] in meters from machine center";
				return false;
			}
		}

		// Оверрайд живёт в surround-блоке индекса экспортов, правится слиянием
		const bool ok = mutate_surround_block(target,
			[&](boost::json::object& surround_obj, std::string&) {
				boost::json::object extr;
				if (auto* e = surround_obj.if_contains("extrinsics"); e && e->is_object()) {
					extr = e->as_object();
				}

				if (reset) {
					extr.erase(place_key);
				}
				else {
					boost::json::object rec;
					rec["position"] = payload.at("position");
					for (const char* k : { "yaw", "pitch", "roll" }) {
						if (auto* a = payload.if_contains(k)) rec[k] = *a;
					}
					extr[place_key] = std::move(rec);
				}
				surround_obj["extrinsics"] = std::move(extr);
				return true;
			}, error);
		if (!ok) {
			m_logger.error("set_surround_camera(): " + error);
			return false;
		}

		m_logger.info("set_surround_camera(): <" + target + "> place=" + place_key
			+ (reset ? " reset" : " manual"));

		// Живой вывод перепекает позы прямо в цикле, без рестарта
		if (m_running.load() && get_active_export_id() == target
			&& resolve_view_mode() == "surround") {
			m_surround_dirty.fetch_or(SURROUND_DIRTY_BAKE);
		}
		return true;
	}

	bool ULinker::mutate_surround_block(const std::string& target,
		const std::function<bool(boost::json::object&, std::string&)>& mutate,
		std::string& error)
	{
		try {
			const auto index_path = m_exports_root / m_exports_index_json;
			std::ifstream f(index_path);
			if (!f) {
				error = "cannot read exports index";
				return false;
			}
			std::stringstream ss; ss << f.rdbuf();
			auto v = boost::json::parse(ss.str());
			if (!v.is_object()) {
				error = "exports index is not an object";
				return false;
			}
			auto root = v.as_object();

			auto* entry = root.if_contains(target);
			if (!entry || !entry->is_object()) {
				error = "export <" + target + "> not found";
				return false;
			}
			auto& entry_obj = entry->as_object();

			auto* surround = entry_obj.if_contains("surround");
			if (!surround || !surround->is_object()) {
				error = "export <" + target + "> has no surround block";
				return false;
			}
			auto& surround_obj = surround->as_object();

			if (!mutate(surround_obj, error)) return false;

			std::ofstream out(index_path);
			out << boost::json::serialize(root);
		}
		catch (const std::exception& e) {
			error = e.what();
			return false;
		}
		return true;
	}

	std::optional<boost::json::object> ULinker::read_surround_cfg(const std::string& export_id) const {
		try {
			std::ifstream f(m_exports_root / m_exports_index_json);
			if (!f) return std::nullopt;
			std::stringstream ss; ss << f.rdbuf();
			auto v = boost::json::parse(ss.str());
			if (!v.is_object()) return std::nullopt;
			if (auto* e = v.as_object().if_contains(export_id); e && e->is_object()) {
				if (auto* s = e->as_object().if_contains("surround"); s && s->is_object()) {
					return s->as_object();
				}
			}
		}
		catch (...) {}
		return std::nullopt;
	}

	bool ULinker::set_surround(const std::string& export_id,
		const boost::json::object& payload, std::string& error)
	{
		std::string target = export_id.empty() ? get_active_export_id() : export_id;
		if (target.empty()) {
			error = "export_id is required when output is stopped";
			return false;
		}

		auto check_num = [&](const boost::json::value& v, const char* name,
			double min_v, bool strict) {
			if (!v.is_number()) {
				error = std::string(name) + " must be a number";
				return false;
			}
			const double d = v.to_number<double>();
			if (strict ? d <= min_v : d < min_v) {
				error = std::string(name) + " out of range";
				return false;
			}
			return true;
		};

		// Тяжесть изменения решает, что сделает живой цикл: перепечку или сеттеры
		unsigned dirty = 0;
		bool any = false;
		for (const auto& kv : payload) {
			const std::string key(kv.key());
			if (key == "export_id") continue;
			any = true;

			if (key == "machine" || key == "bowl") {
				if (!kv.value().is_object()) { error = key + " must be an object"; return false; }
				dirty |= SURROUND_DIRTY_BAKE;
			}
			else if (key == "orbit" || key == "model") {
				if (!kv.value().is_object()) { error = key + " must be an object"; return false; }
				dirty |= SURROUND_DIRTY_VISUAL;
			}
			else if (key == "plate" || key == "wireframe" || key == "photometric") {
				if (!kv.value().is_bool()) { error = key + " must be a bool"; return false; }
				dirty |= SURROUND_DIRTY_VISUAL;
			}
			else {
				error = "unknown key <" + key + ">";
				return false;
			}
		}
		if (!any) {
			error = "empty payload";
			return false;
		}

		if (auto* m = payload.if_contains("machine"); m && m->is_object()) {
			for (const char* k : { "length", "width", "height" }) {
				if (auto* v = m->as_object().if_contains(k)) {
					if (!check_num(*v, k, 0.0, true)) return false;
				}
			}
		}
		if (auto* b = payload.if_contains("bowl"); b && b->is_object()) {
			for (const char* k : { "floor", "outer", "wall", "plate", "blend" }) {
				if (auto* v = b->as_object().if_contains(k)) {
					if (!check_num(*v, k, 0.0, true)) return false;
				}
			}
		}
		if (auto* o = payload.if_contains("orbit"); o && o->is_object()) {
			for (const char* k : { "distance", "height" }) {
				if (auto* v = o->as_object().if_contains(k)) {
					if (!check_num(*v, k, 0.0, true)) return false;
				}
			}
			if (auto* v = o->as_object().if_contains("speed")) {
				if (!check_num(*v, "speed", 0.0, false)) return false;
			}
		}
		if (auto* mo = payload.if_contains("model"); mo && mo->is_object()) {
			for (const char* k : { "length", "width", "height" }) {
				if (auto* v = mo->as_object().if_contains(k)) {
					if (!check_num(*v, k, 0.0, false)) return false;
				}
			}
			if (auto* v = mo->as_object().if_contains("alpha")) {
				if (!check_num(*v, "alpha", 0.0, false)) return false;
				if (v->to_number<double>() > 1.0) { error = "alpha out of range"; return false; }
			}
		}

		const bool ok = mutate_surround_block(target,
			[&](boost::json::object& surround_obj, std::string&) {
				for (const auto& kv : payload) {
					const std::string key(kv.key());
					if (key == "export_id") continue;
					if (kv.value().is_object()) {
						// Группы мёржатся пообъектно, соседние поля не затираются
						boost::json::object group;
						if (auto* g = surround_obj.if_contains(key); g && g->is_object()) {
							group = g->as_object();
						}
						for (const auto& sub : kv.value().as_object()) {
							group[sub.key()] = sub.value();
						}
						surround_obj[key] = std::move(group);
					}
					else {
						surround_obj[key] = kv.value();
					}
				}
				return true;
			}, error);
		if (!ok) {
			m_logger.error("set_surround(): " + error);
			return false;
		}

		m_logger.info("set_surround(): <" + target + "> merged, dirty=" + std::to_string(dirty));

		if (m_running.load() && get_active_export_id() == target
			&& resolve_view_mode() == "surround") {
			m_surround_dirty.fetch_or(dirty);
		}
		return true;
	}

	bool ULinker::get_surround(const std::string& export_id,
		boost::json::object& out, std::string& error)
	{
		std::string target = export_id.empty() ? get_active_export_id() : export_id;
		if (target.empty()) {
			error = "no active export";
			return false;
		}

		auto cfg_opt = read_surround_cfg(target);
		if (!cfg_opt) {
			error = "export <" + target + "> has no surround block";
			return false;
		}
		const auto& cfg = *cfg_opt;

		// Дефолты совпадают с печкой и рендерером, поверх — сохранённое
		boost::json::object machine{ {"length", 0.0}, {"width", 0.0}, {"height", 0.0} };
		boost::json::object bowl{ {"floor", 0.9}, {"outer", 2.3}, {"wall", 0.9},
			{"plate", 1.5}, {"blend", 0.3} };
		boost::json::object orbit{ {"distance", 3.4}, {"height", 2.0}, {"speed", 0.25} };
		boost::json::object model{ {"length", 0.0}, {"width", 0.0}, {"height", 0.0}, {"alpha", 1.0} };

		auto overlay = [&](boost::json::object& base, const char* key) {
			if (auto* g = cfg.if_contains(key); g && g->is_object()) {
				for (const auto& kv : g->as_object()) base[kv.key()] = kv.value();
			}
		};
		overlay(machine, "machine");
		overlay(bowl, "bowl");
		overlay(orbit, "orbit");
		overlay(model, "model");

		auto flag = [&](const char* key, bool def) {
			if (auto* v = cfg.if_contains(key); v && v->is_bool()) return v->as_bool();
			return def;
		};

		out["export_id"] = target;
		if (auto* p = cfg.if_contains("preset")) out["preset"] = *p;
		out["machine"] = std::move(machine);
		out["bowl"] = std::move(bowl);
		out["orbit"] = std::move(orbit);
		out["model"] = std::move(model);
		out["plate"] = flag("plate", true);
		out["wireframe"] = flag("wireframe", false);
		out["photometric"] = flag("photometric", true);

		// Позы есть только у живой печки активного экспорта
		boost::json::array cams;
		{
			std::lock_guard<std::mutex> lk(m_mutex);
			if (m_running.load() && m_export_id == target) {
				for (const auto& c : m_surround_cameras) {
					boost::json::object o;
					o["place_key"] = c.place_key;
					o["camera_id"] = c.camera_id;
					o["source"] = c.manual ? "manual" : "pnp";
					o["height"] = c.camera_height;
					o["reprojection_error"] = c.reprojection_error;
					o["position"] = boost::json::array{
						c.position[0], c.position[1], c.position[2] };
					o["yaw"] = c.yaw;
					o["pitch"] = c.pitch;
					o["roll"] = c.roll;
					cams.push_back(std::move(o));
				}
			}
		}
		out["cameras"] = std::move(cams);
		return true;
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

		if (resolve_view_mode() == "surround") {
			surround_loop(fps);
			m_context_manager->undone_current(&m_logger);
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

		// Поворот — параметр конфигурации, из формы канваса он больше не выводится
		const int degrees = resolve_rotation();
		renderer.set_rotation(degrees / 90);

		// Стороны округляются вверх до FRAME_ALIGNMENT, картинка растягивается
		const int outW = align_frame_side(renderer.rotated_width());
		const int outH = align_frame_side(renderer.rotated_height());
		renderer.set_output_size(outW, outH);

		{
			std::lock_guard<std::mutex> lk(m_mutex);
			m_out_width = outW;
			m_out_height = outH;
		}

		m_logger.info("processing_loop(): src=" + std::to_string(W) + "x" + std::to_string(H) +
			", out=" + std::to_string(outW) + "x" + std::to_string(outH) +
			", rotation=" + std::to_string(degrees));

		if (outW != renderer.rotated_width() || outH != renderer.rotated_height()) {
			m_logger.warn("processing_loop(): output aligned from " +
				std::to_string(renderer.rotated_width()) + "x" + std::to_string(renderer.rotated_height()));
		}

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

	void ULinker::surround_loop(uint32_t fps) {
		using clock = std::chrono::high_resolution_clock;

		USurroundRenderer renderer;
		if (!renderer.init(0, m_context_manager, &m_logger)) {
			m_logger.error("surround_loop(): renderer init failed");
			return;
		}

		std::string export_id_copy;
		NCamerasPurpose bindings;
		{
			std::lock_guard<std::mutex> lk(m_mutex);
			export_id_copy = m_export_id;
			bindings = m_cameras_purpose;
		}

		// Лёгкие параметры сцены: и на старте, и на живом изменении ручкой
		auto apply_visuals = [&](const boost::json::object& cfg) {
			auto num = [](const boost::json::object& o, const char* k, double def) {
				if (auto* v = o.if_contains(k); v && v->is_number()) return v->to_number<double>();
				return def;
			};
			auto flag = [&](const char* k, bool def) {
				if (auto* v = cfg.if_contains(k); v && v->is_bool()) return v->as_bool();
				return def;
			};
			boost::json::object orbit, model;
			if (auto* v = cfg.if_contains("orbit"); v && v->is_object()) orbit = v->as_object();
			if (auto* v = cfg.if_contains("model"); v && v->is_object()) model = v->as_object();

			renderer.set_orbit(
				static_cast<float>(num(orbit, "distance", 3.4)),
				static_cast<float>(num(orbit, "height", 2.0)),
				static_cast<float>(num(orbit, "speed", 0.25)));
			renderer.set_model(
				static_cast<float>(num(model, "width", 0.0)),
				static_cast<float>(num(model, "height", 0.0)),
				static_cast<float>(num(model, "length", 0.0)),
				static_cast<float>(num(model, "alpha", 1.0)));
			renderer.set_plate(flag("plate", true));
			renderer.set_wireframe(flag("wireframe", false));
			renderer.set_photometric_enabled(flag("photometric", true));
		};

		// Печка: габарит применяется до неё, чаша перестраивается под масштаб
		// сцены, и проецируются уже отмасштабированные вершины
		auto apply_bake = [&](const boost::json::object& cfg) -> bool {
			USurroundBaker baker(&m_logger);
			FSurroundMachine machine;
			FSurroundBake bake;
			std::string bake_error;

			bool ok = USurroundBaker::parse_machine(cfg, machine, bake_error);
			if (ok) {
				renderer.set_bowl_factors(machine.bowl_floor, machine.bowl_outer,
					machine.bowl_wall, machine.bowl_plate);
				renderer.set_machine(machine.width, machine.height, machine.length);
				ok = baker.bake(
					cfg,
					calib_consts::PROJECTION_CONFIGURES_PATH,
					calib_consts::CALIBRATION_CONFIGURES_PATH,
					bindings, renderer.bowl_positions(), bake, bake_error);
			}

			if (!ok || !renderer.set_camera_attributes(bake.camera_attributes)) {
				m_logger.error("surround_loop(): bake failed: " + bake_error + ", grid only");
				return false;
			}

			renderer.set_photometric_pairs(bake.photo_pairs);

			std::vector<std::string> keys;
			for (const auto& cam : bake.cameras) keys.push_back(cam.place_key);
			std::lock_guard<std::mutex> lk(m_mutex);
			m_camera_keys = std::move(keys);
			m_surround_cameras = std::move(bake.cameras);
			return true;
		};

		// Без surround-блока в экспорте остаётся сетка первого блока
		if (auto cfg = read_surround_cfg(export_id_copy)) {
			apply_visuals(*cfg);
			apply_bake(*cfg);
		}
		else {
			m_logger.info("surround_loop(): no surround block in export, grid only");
		}
		m_surround_dirty.store(0);

		const int outW = constants::SURROUND_WIDTH;
		const int outH = constants::SURROUND_HEIGHT;
		renderer.set_output_size(outW, outH);

		{
			std::lock_guard<std::mutex> lk(m_mutex);
			m_out_width = outW;
			m_out_height = outH;
		}

		m_logger.info("surround_loop(): out=" + std::to_string(outW) + "x" + std::to_string(outH));

		if (!m_context_manager->init_render_framebuffer(outW, outH, &m_logger)) {
			m_logger.error("surround_loop(): cannot init render FBO");
			return;
		}

		if (m_websocket.ip_adress.empty() || m_websocket.port.empty()) {
			m_logger.error("surround_loop(): websocket is incorrect, aborted starting connection!");
			return;
		}

		const auto params = get_stream_params();
		m_stream_id = params.stream_id;
		fps = params.fps;

		m_streamer = std::make_unique<neural::UVirtualCamera>(m_stream_id, m_websocket);
		if (!m_streamer->set_parameters(outW, outH, fps)) {
			m_logger.error("surround_loop(): streamer set_parameters failed");
			return;
		}
		if (!m_streamer->initialize()) {
			m_logger.error("surround_loop(): streamer initialize failed");
			return;
		}
		if (!m_streamer->start()) {
			m_logger.error("surround_loop(): streamer start failed");
			return;
		}
		m_logger.info("surround_loop(): streamer started, stream_id=" + m_stream_id);

		std::vector<uint8_t> pixels(static_cast<size_t>(outW) * outH * 4);

		const auto frame_time = std::chrono::microseconds(1000000 / fps);
		const float dt = 1.0f / static_cast<float>(fps);
		auto next_frame = clock::now();
		auto space = create_linking_space();

		// Фактический темп и стоимость кадра, раз в пять секунд
		auto stats_start = clock::now();
		int stats_frames = 0;
		double stats_work_ms = 0.0;

		while (m_running) {
			next_frame += frame_time;
			const auto work_start = clock::now();

			// Живые изменения ручки: лёгкие - сеттеры, тяжёлые - перепечка
			if (const unsigned dirty = m_surround_dirty.exchange(0)) {
				if (auto cfg = read_surround_cfg(export_id_copy)) {
					apply_visuals(*cfg);
					if (dirty & SURROUND_DIRTY_BAKE) {
						if (apply_bake(*cfg)) space = create_linking_space();
					}
				}
			}

			fill_linking_space(space);
			renderer.update_textures(space, m_context_manager->get_display());
			renderer.update(dt);
			renderer.render(static_cast<float>(outW) / static_cast<float>(outH));

			glReadPixels(0, 0, outW, outH, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());

			cv::Mat img(outH, outW, CV_8UC4, pixels.data());
			if (m_streamer) m_streamer->push_frame(img);

			stats_work_ms += std::chrono::duration<double, std::milli>(clock::now() - work_start).count();
			++stats_frames;

			const auto stats_elapsed = std::chrono::duration<double>(clock::now() - stats_start).count();
			if (stats_elapsed >= 5.0 && stats_frames > 0) {
				const int fps10 = static_cast<int>(stats_frames / stats_elapsed * 10.0 + 0.5);
				const int work10 = static_cast<int>(stats_work_ms / stats_frames * 10.0 + 0.5);
				m_logger.info("surround_loop(): fps=" + std::to_string(fps10 / 10) + "." + std::to_string(fps10 % 10)
					+ ", frame work=" + std::to_string(work10 / 10) + "." + std::to_string(work10 % 10)
					+ " ms of " + std::to_string(1000 / fps) + " ms budget");
				stats_start = clock::now();
				stats_frames = 0;
				stats_work_ms = 0.0;
			}

			std::this_thread::sleep_until(next_frame);
		}

		if (m_streamer) {
			m_streamer->stop_websocket_client();
			m_streamer->stop();
			m_streamer.reset();
		}
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