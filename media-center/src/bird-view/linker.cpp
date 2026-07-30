#include "bird-view/linker.h"
#include "core/paths.h"
#include "bird-view/output-mode.h"
#include "bird-view/top-output.h"
#include "bird-view/top-bake.h"
#include "bird-view/surround-output.h"
#include "bird-view/surround-camera.h"
#include "bird-view/egl-context.h"

#include "calibration/constants.h"

#include <boost/json.hpp>
#include <opencv2/opencv.hpp>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>

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
		: m_storage(storage)
		, m_context_manager(manager)
		, m_logger("Bird ULinker", level)
		, m_store(
			varan::paths().surround.projection_root,
			calib_consts::LINKER_CONFIGURATION_INDEX,
			varan::paths().surround.linker_state_root,
			calib_consts::LINKER_STATE_INDEX,
			&m_logger)
		, m_fps(fps)
		, m_websocket(websocket)
	{
		reload_from_state();
	}

	ULinker::~ULinker() {
		stop();
	}

	bool ULinker::reload_from_state() {
		auto root = m_store.read_state();

		const std::string export_id_from_state = js::str(root, "active");
		if (export_id_from_state.empty()) {
			m_logger.warn("reload_from_state(): no active configuration");
			return false;
		}

		const auto* configs = js::obj(root, "configs");
		const auto* entry = configs ? js::obj(*configs, export_id_from_state.c_str()) : nullptr;
		if (!entry) {
			m_logger.warn("reload_from_state(): no entry for <" + export_id_from_state + ">");
			return false;
		}

		NCamerasPurpose desired;
		if (const auto* cams = js::obj(*entry, "cameras")) {
			for (const auto& [k, val] : *cams) {
				if (val.is_string()) {
					desired[std::string(k)] = std::string(val.as_string().c_str());
				}
				else {
					desired[std::string(k)] = std::nullopt;
				}
			}
		}

		FStreamParams params;
		params.fps = static_cast<uint32_t>(js::num(*entry, "fps", 0));
		params.stream_id = js::str(*entry, "stream_id");
		params.stream_name = js::str(*entry, "stream_name");

		const int degrees = static_cast<int>(js::num(*entry, "rotation", -1));
		if (is_valid_rotation(degrees)) params.rotation = degrees;
		else if (degrees != -1) {
			m_logger.warn("reload_from_state(): bad rotation " + std::to_string(degrees));
		}

		const std::string mode = js::str(*entry, "view_mode");
		if (is_valid_view_mode(mode)) params.view_mode = mode;
		else if (!mode.empty()) {
			m_logger.warn("reload_from_state(): bad view_mode " + mode);
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
		auto root = m_store.read_state();
		const auto* configs = js::obj(root, "configs");
		const auto* entry = configs ? js::obj(*configs, target.c_str()) : nullptr;
		if (!entry) return 0;

		const int degrees = static_cast<int>(js::num(*entry, "rotation", 0));
		return is_valid_rotation(degrees) ? degrees : 0;
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
		auto root = m_store.read_state();
		const auto* configs = js::obj(root, "configs");
		const auto* entry = configs ? js::obj(*configs, target.c_str()) : nullptr;
		if (!entry) return "top";

		const std::string mode = js::str(*entry, "view_mode");
		return is_valid_view_mode(mode) ? mode : "top";
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
		// Ключи камер берутся из записи экспорта — это правда о конфигурации
		auto entry = m_store.read_export_entry(export_id);
		if (!entry) {
			m_logger.error("apply_export(): export <" + export_id + "> not found in index");
			return false;
		}
		const auto* cams = js::obj(*entry, "cameras");
		if (!cams) {
			m_logger.error("apply_export(): export <" + export_id + "> has no cameras");
			return false;
		}

		// Собираем итоговый purpose: ключи из записи, значения из состояния
		std::lock_guard<std::mutex> lk(m_mutex);
		m_export_id = export_id;
		m_camera_keys.clear();
		m_cameras_purpose.clear();

		for (const auto& [k, _] : *cams) {
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

		auto rect_ok = [](const boost::json::object& o) {
			const auto* r = js::arr(o, "rect");
			return r && r->size() == 4;
		};

		for (const auto& [id, val] : m_store.read_exports_root()) {
			if (!val.is_object()) continue;
			const auto& obj = val.as_object();

			FExportInfo info;
			info.id = id;
			info.name = js::str(obj, "name", info.id);
			if (const auto* cams = js::obj(obj, "cameras")) {
				for (const auto& [k, _] : *cams) info.cameras.emplace_back(k);
			}

			// Рект машины по цепочке: габарит, картинка, ручной surround
			bool has_rect = false;
			if (const auto* m = js::obj(obj, "machine")) has_rect = rect_ok(*m);
			if (!has_rect) {
				if (const auto* imgs = js::arr(obj, "images"); imgs && !imgs->empty()
					&& imgs->front().is_object()) {
					has_rect = rect_ok(imgs->front().as_object());
				}
			}
			if (!has_rect) {
				if (const auto* s = js::obj(obj, "surround")) {
					if (const auto* m = js::obj(*s, "machine")) has_rect = rect_ok(*m);
				}
			}
			info.valid = has_rect;

			result.push_back(std::move(info));
		}
		return result;
	}

	boost::json::object ULinker::get_state_raw() {
		return m_store.read_state();
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

		std::string error;
		const bool ok = m_store.mutate_state_entry(export_id,
			[&](boost::json::object& entry) {
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
			}, true, error);
		if (!ok) {
			m_logger.error("write_state(): " + error);
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

		if (!m_store.mutate_state_entry(target,
			[&](boost::json::object& entry) { entry["rotation"] = degrees; },
			false, error)) {
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

		if (!m_store.mutate_state_entry(target,
			[&](boost::json::object& entry) { entry["view_mode"] = mode; },
			false, error)) {
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

		const bool reset = js::flag(payload, "reset", false);

		if (!reset) {
			auto* pos = payload.if_contains("position");
			if (!pos || !pos->is_array() || pos->as_array().size() != 3) {
				error = "position must be [x,y,z] in meters from machine center";
				return false;
			}
		}

		// Оверрайд живёт в surround-блоке индекса экспортов, правится слиянием
		const bool ok = m_store.mutate_surround_block(target,
			[&](boost::json::object& surround_obj, std::string&) {
				boost::json::object extr;
				if (auto* e = js::obj(surround_obj, "extrinsics")) extr = *e;

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

	namespace {

		// Вид проверки одного поля ручки /linker/surround
		enum class EFieldKind {
			NumPositive,     // число строго больше нуля
			NumNonNegative,  // число, ноль допустим
			NumAny,          // любое число
			NumAlpha,        // число в [0..1]
			Flag,            // bool
			SourceName,      // имя файла модели, пустое снимает модель
		};

		struct FSurroundField {
			const char* group;   // nullptr — ключ верхнего уровня
			const char* key;
			EFieldKind kind;
			unsigned dirty;
		};

		// Правила всех полей в одном месте: тип, диапазон и тяжесть применения
		const FSurroundField SURROUND_FIELDS[] = {
			{ "machine", "length", EFieldKind::NumPositive,   SURROUND_DIRTY_BAKE },
			{ "machine", "width",  EFieldKind::NumPositive,   SURROUND_DIRTY_BAKE },
			{ "machine", "height", EFieldKind::NumPositive,   SURROUND_DIRTY_BAKE },
			{ "bowl", "floor",     EFieldKind::NumPositive,   SURROUND_DIRTY_BAKE },
			{ "bowl", "wall",      EFieldKind::NumPositive,   SURROUND_DIRTY_BAKE },
			{ "bowl", "plate",     EFieldKind::NumPositive,   SURROUND_DIRTY_BAKE },
			{ "bowl", "blend",     EFieldKind::NumPositive,   SURROUND_DIRTY_BAKE },
			// Ноль допустим: вертикальная стенка и прямые углы
			{ "bowl", "outer",     EFieldKind::NumNonNegative, SURROUND_DIRTY_BAKE },
			{ "bowl", "corner",    EFieldKind::NumNonNegative, SURROUND_DIRTY_BAKE },
			{ "orbit", "distance", EFieldKind::NumPositive,   SURROUND_DIRTY_VISUAL },
			{ "orbit", "height",   EFieldKind::NumPositive,   SURROUND_DIRTY_VISUAL },
			{ "orbit", "speed",    EFieldKind::NumNonNegative, SURROUND_DIRTY_VISUAL },
			// Дефолт ручного управления на отображении, применяется и живьём
			{ "orbit", "interactive", EFieldKind::Flag,       SURROUND_DIRTY_VISUAL },
			{ "model", "length",   EFieldKind::NumNonNegative, SURROUND_DIRTY_VISUAL },
			{ "model", "width",    EFieldKind::NumNonNegative, SURROUND_DIRTY_VISUAL },
			{ "model", "height",   EFieldKind::NumNonNegative, SURROUND_DIRTY_VISUAL },
			{ "model", "alpha",    EFieldKind::NumAlpha,      SURROUND_DIRTY_VISUAL },
			{ "model", "rotation", EFieldKind::NumAny,        SURROUND_DIRTY_VISUAL },
			{ "model", "source",   EFieldKind::SourceName,    SURROUND_DIRTY_VISUAL },
			{ nullptr, "plate",       EFieldKind::Flag,           SURROUND_DIRTY_VISUAL },
			{ nullptr, "wireframe",   EFieldKind::Flag,           SURROUND_DIRTY_VISUAL },
			{ nullptr, "photometric", EFieldKind::Flag,           SURROUND_DIRTY_VISUAL },
			{ nullptr, "plate_length", EFieldKind::NumNonNegative, SURROUND_DIRTY_VISUAL },
			{ nullptr, "plate_width",  EFieldKind::NumNonNegative, SURROUND_DIRTY_VISUAL },
		};

		bool check_surround_field(const FSurroundField& rule,
			const boost::json::value& v, std::string& error)
		{
			const std::string name = rule.key;
			switch (rule.kind) {
			case EFieldKind::NumPositive:
			case EFieldKind::NumNonNegative:
			case EFieldKind::NumAny:
			case EFieldKind::NumAlpha: {
				if (!v.is_number()) {
					error = name + " must be a number";
					return false;
				}
				const double d = v.to_number<double>();
				if (rule.kind == EFieldKind::NumPositive && d <= 0.0) {
					error = name + " out of range";
					return false;
				}
				if ((rule.kind == EFieldKind::NumNonNegative
					|| rule.kind == EFieldKind::NumAlpha) && d < 0.0) {
					error = name + " out of range";
					return false;
				}
				if (rule.kind == EFieldKind::NumAlpha && d > 1.0) {
					error = name + " out of range";
					return false;
				}
				return true;
			}
			case EFieldKind::Flag:
				if (!v.is_bool()) {
					error = name + " must be a bool";
					return false;
				}
				return true;
			case EFieldKind::SourceName: {
				if (!v.is_string()) {
					error = name + " must be a string";
					return false;
				}
				// Имя уходит в путь; пустая строка снимает модель
				const std::string src = v.as_string().c_str();
				for (char c : src) {
					const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
						|| (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.';
					if (!ok) {
						error = name + " contains invalid characters";
						return false;
					}
				}
				if (src.find("..") != std::string::npos) {
					error = name + " contains invalid characters";
					return false;
				}
				return true;
			}
			}
			return true;
		}

		bool is_surround_group(const std::string& key) {
			return key == "machine" || key == "bowl" || key == "orbit" || key == "model";
		}

	} // namespace

	bool ULinker::set_surround(const std::string& export_id,
		const boost::json::object& payload, std::string& error)
	{
		std::string target = export_id.empty() ? get_active_export_id() : export_id;
		if (target.empty()) {
			error = "export_id is required when output is stopped";
			return false;
		}

		// Проверка по таблице; тяжесть изменения решает, что сделает живой цикл
		unsigned dirty = 0;
		bool any = false;
		for (const auto& kv : payload) {
			const std::string key(kv.key());
			if (key == "export_id") continue;
			any = true;

			if (key == "resolution") {
				// Применяется рестартом вывода, dirty-флаги ей не нужны
				if (!kv.value().is_object()) {
					error = key + " must be an object";
					return false;
				}
				continue;
			}

			if (key == "calibration") {
				// Карта camera_id - ключ записи калибровки; раньше её можно
				// было завести только правкой файла руками
				if (!kv.value().is_object()) {
					error = key + " must be an object";
					return false;
				}
				for (const auto& sub : kv.value().as_object()) {
					if (!sub.value().is_string()) {
						error = "calibration values must be strings";
						return false;
					}
				}
				dirty |= SURROUND_DIRTY_BAKE;
				continue;
			}

			if (is_surround_group(key)) {
				if (!kv.value().is_object()) {
					error = key + " must be an object";
					return false;
				}
				dirty |= (key == "machine" || key == "bowl")
					? SURROUND_DIRTY_BAKE : SURROUND_DIRTY_VISUAL;

				const auto& group = kv.value().as_object();
				for (const auto& rule : SURROUND_FIELDS) {
					if (!rule.group || key != rule.group) continue;
					if (auto* v = group.if_contains(rule.key)) {
						if (!check_surround_field(rule, *v, error)) return false;
					}
				}
				continue;
			}

			const FSurroundField* rule = nullptr;
			for (const auto& r : SURROUND_FIELDS) {
				if (!r.group && key == r.key) { rule = &r; break; }
			}
			if (!rule) {
				error = "unknown key <" + key + ">";
				return false;
			}
			if (!check_surround_field(*rule, kv.value(), error)) return false;
			dirty |= rule->dirty;
		}
		if (!any) {
			error = "empty payload";
			return false;
		}

		// Разрешение сервер страхует сам: кламп и кратность 16 до записи
		boost::json::object body = payload;
		bool resolution_changed = false;
		if (auto* r = body.if_contains("resolution"); r && r->is_object()) {
			auto& ro = r->as_object();
			for (const char* k : { "width", "height" }) {
				if (auto* v = ro.if_contains(k); v && !v->is_number()) {
					error = std::string(k) + " must be a number";
					return false;
				}
			}
			const int res_w = clamp_frame_side(
				js::num(ro, "width", constants::SURROUND_WIDTH),
				SURROUND_RES_MIN, SURROUND_RES_MAX_W);
			const int res_h = clamp_frame_side(
				js::num(ro, "height", constants::SURROUND_HEIGHT),
				SURROUND_RES_MIN, SURROUND_RES_MAX_H);
			ro["width"] = res_w;
			ro["height"] = res_h;

			int old_w = constants::SURROUND_WIDTH;
			int old_h = constants::SURROUND_HEIGHT;
			if (auto cfg = m_store.read_surround_cfg(target)) {
				if (auto* rr = js::obj(*cfg, "resolution")) {
					old_w = static_cast<int>(js::num(*rr, "width", old_w));
					old_h = static_cast<int>(js::num(*rr, "height", old_h));
				}
			}
			resolution_changed = (res_w != old_w || res_h != old_h);
		}

		const bool ok = m_store.mutate_surround_block(target,
			[&](boost::json::object& surround_obj, std::string&) {
				for (const auto& kv : body) {
					const std::string key(kv.key());
					if (key == "export_id") continue;
					if (kv.value().is_object()) {
						// Группы мёржатся пообъектно, соседние поля не затираются
						boost::json::object group;
						if (auto* g = js::obj(surround_obj, key.c_str())) group = *g;
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
			// Тумблер ручного вращения действует сразу, кнопка плеера может перебить
			if (auto* o = js::obj(payload, "orbit")) {
				if (auto* v = o->if_contains("interactive"); v && v->is_bool()) {
					m_surround_mode_request.store(v->as_bool() ? 1 : 0);
				}
			}
			// Размер кадра задан пайплайну при создании, живьём его не сменить
			if (resolution_changed) {
				m_logger.info("set_surround(): resolution changed, restarting output");
				if (!restart()) {
					error = "resolution saved, but output restart failed";
					return false;
				}
			}
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

		auto cfg_opt = m_store.read_surround_cfg(target);
		if (!cfg_opt) {
			error = "export <" + target + "> has no surround block";
			return false;
		}
		const auto& cfg = *cfg_opt;

		// Дефолты совпадают с печкой и рендерером, поверх — сохранённое
		boost::json::object machine{ {"length", 0.0}, {"width", 0.0}, {"height", 0.0} };
		boost::json::object bowl{ {"floor", 0.9}, {"outer", 1.4}, {"wall", 0.9},
			{"plate", 1.5}, {"blend", 0.3}, {"corner", 1.0} };
		boost::json::object orbit{ {"distance", 3.4}, {"height", 2.0}, {"speed", 0.25},
			{"interactive", false} };
		boost::json::object model{ {"length", 0.0}, {"width", 0.0}, {"height", 0.0},
			{"alpha", 1.0}, {"rotation", 0.0}, {"source", ""} };
		boost::json::object resolution{ {"width", constants::SURROUND_WIDTH},
			{"height", constants::SURROUND_HEIGHT} };

		auto overlay = [&](boost::json::object& base, const char* key) {
			if (const auto* g = js::obj(cfg, key)) {
				for (const auto& kv : *g) base[kv.key()] = kv.value();
			}
		};
		// Пресет конфигуратора предзаполняет метры, правка пользователя выше
		if (auto entry = m_store.read_export_entry(target)) {
			if (const auto* m = js::obj(*entry, "machine")) {
				for (const char* k : { "length", "width", "height" }) {
					if (auto* v = m->if_contains(k); v && v->is_number()) machine[k] = *v;
				}
			}
		}
		overlay(machine, "machine");
		overlay(bowl, "bowl");
		overlay(orbit, "orbit");
		overlay(model, "model");
		overlay(resolution, "resolution");

		out["export_id"] = target;
		if (auto* p = cfg.if_contains("preset")) out["preset"] = *p;
		if (auto* c = cfg.if_contains("calibration")) out["calibration"] = *c;
		out["machine"] = std::move(machine);
		out["bowl"] = std::move(bowl);
		out["orbit"] = std::move(orbit);
		out["model"] = std::move(model);
		out["resolution"] = std::move(resolution);
		out["plate"] = js::flag(cfg, "plate", true);
		out["wireframe"] = js::flag(cfg, "wireframe", false);
		out["photometric"] = js::flag(cfg, "photometric", true);
		out["plate_length"] = js::num(cfg, "plate_length", 0.0);
		out["plate_width"] = js::num(cfg, "plate_width", 0.0);

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
					// Расчётная база: к ней форма откатывает отдельные поля
					o["pnp_position"] = boost::json::array{
						c.pnp_position[0], c.pnp_position[1], c.pnp_position[2] };
					o["pnp_yaw"] = c.pnp_yaw;
					o["pnp_pitch"] = c.pnp_pitch;
					o["pnp_roll"] = c.pnp_roll;
					cams.push_back(std::move(o));
				}
			}
		}
		out["cameras"] = std::move(cams);
		return true;
	}

	namespace {

		// Правила полей ручки /linker/top: та же таблица, что у surround
		const FSurroundField TOP_FIELDS[] = {
			{ "model", "length",   EFieldKind::NumNonNegative, TOP_DIRTY_VISUAL },
			{ "model", "width",    EFieldKind::NumNonNegative, TOP_DIRTY_VISUAL },
			{ "model", "height",   EFieldKind::NumNonNegative, TOP_DIRTY_VISUAL },
			{ "model", "alpha",    EFieldKind::NumAlpha,       TOP_DIRTY_VISUAL },
			{ "model", "rotation", EFieldKind::NumAny,         TOP_DIRTY_VISUAL },
			{ "model", "source",   EFieldKind::SourceName,     TOP_DIRTY_VISUAL },
			// Ширина шва применяется перепечкой весов, не dirty-флагом
			{ nullptr, "blend",        EFieldKind::NumPositive,    0 },
			{ nullptr, "photometric",  EFieldKind::Flag,           TOP_DIRTY_VISUAL },
			{ nullptr, "plate",        EFieldKind::Flag,           TOP_DIRTY_VISUAL },
			{ nullptr, "plate_length", EFieldKind::NumNonNegative, TOP_DIRTY_VISUAL },
			{ nullptr, "plate_width",  EFieldKind::NumNonNegative, TOP_DIRTY_VISUAL },
		};

		// Выровненный размер канваса с учётом поворота: разрешение по умолчанию
		void top_natural_size(const boost::json::object& entry, int rotation,
			int& out_w, int& out_h)
		{
			int cw = static_cast<int>(js::num(entry, "width", 0));
			int ch = static_cast<int>(js::num(entry, "height", 0));
			if (rotation == 90 || rotation == 270) std::swap(cw, ch);
			out_w = align_frame_side(cw);
			out_h = align_frame_side(ch);
		}

		// Список версий записи; легаси без поля versions - единственная v1
		boost::json::array top_versions_of(const boost::json::object& entry) {
			if (const auto* v = js::arr(entry, "versions"); v && !v->empty()) return *v;
			return boost::json::array{ boost::json::object{ {"key", "v1"}, {"created", 0} } };
		}

	} // namespace

	bool ULinker::set_top(const std::string& export_id,
		const boost::json::object& payload, std::string& error)
	{
		std::string target = export_id.empty() ? get_active_export_id() : export_id;
		if (target.empty()) {
			error = "export_id is required when output is stopped";
			return false;
		}

		auto entry = m_store.read_export_entry(target);
		if (!entry) {
			error = "export <" + target + "> not found";
			return false;
		}

		// Всё новое живёт на версиях текущего поколения печки
		const std::string version = top_active_version(*entry);
		if (top_version_generation(version) < TOP_BAKE_GENERATION) {
			error = "top settings need version v" + std::to_string(TOP_BAKE_GENERATION)
				+ ", recalculate the export first";
			return false;
		}

		unsigned dirty = 0;
		bool any = false;
		for (const auto& kv : payload) {
			const std::string key(kv.key());
			if (key == "export_id") continue;
			any = true;

			if (key == "resolution") {
				// Применяется рестартом вывода, dirty-флаги ей не нужны
				if (!kv.value().is_object()) {
					error = key + " must be an object";
					return false;
				}
				continue;
			}

			if (key == "calibration") {
				// Карта camera_id - ключ записи калибровки, читает её пересчёт
				if (!kv.value().is_object()) {
					error = key + " must be an object";
					return false;
				}
				for (const auto& sub : kv.value().as_object()) {
					if (!sub.value().is_string()) {
						error = "calibration values must be strings";
						return false;
					}
				}
				continue;
			}

			if (key == "images") {
				// Правки рисунков по имени файла: показ и размер в пикселях
				if (!kv.value().is_object()) {
					error = key + " must be an object";
					return false;
				}
				for (const auto& sub : kv.value().as_object()) {
					if (!sub.value().is_object()) {
						error = "images values must be objects";
						return false;
					}
					const auto& io = sub.value().as_object();
					if (auto* v = io.if_contains("visible"); v && !v->is_bool()) {
						error = "visible must be a bool";
						return false;
					}
					for (const char* f : { "width", "height" }) {
						if (auto* v = io.if_contains(f)) {
							if (!v->is_number() || v->to_number<double>() <= 0) {
								error = std::string(f) + " out of range";
								return false;
							}
						}
					}
				}
				dirty |= TOP_DIRTY_VISUAL;
				continue;
			}

			if (key == "model") {
				if (!kv.value().is_object()) {
					error = key + " must be an object";
					return false;
				}
				dirty |= TOP_DIRTY_VISUAL;
				const auto& group = kv.value().as_object();
				for (const auto& rule : TOP_FIELDS) {
					if (!rule.group || key != rule.group) continue;
					if (auto* v = group.if_contains(rule.key)) {
						if (!check_surround_field(rule, *v, error)) return false;
					}
				}
				continue;
			}

			const FSurroundField* rule = nullptr;
			for (const auto& r : TOP_FIELDS) {
				if (!r.group && key == r.key) { rule = &r; break; }
			}
			if (!rule) {
				error = "unknown key <" + key + ">";
				return false;
			}
			if (!check_surround_field(*rule, kv.value(), error)) return false;
			dirty |= rule->dirty;
		}
		if (!any) {
			error = "empty payload";
			return false;
		}

		boost::json::object cfg;
		if (auto c = m_store.read_top_cfg(target)) cfg = *c;

		// Разрешение сервер страхует сам: кламп и кратность 16 до записи
		boost::json::object body = payload;
		bool resolution_changed = false;
		if (auto* r = body.if_contains("resolution"); r && r->is_object()) {
			auto& ro = r->as_object();
			for (const char* k : { "width", "height" }) {
				if (auto* v = ro.if_contains(k); v && !v->is_number()) {
					error = std::string(k) + " must be a number";
					return false;
				}
			}
			int def_w = 0, def_h = 0;
			top_natural_size(*entry, resolve_rotation(target), def_w, def_h);
			const int res_w = clamp_frame_side(
				js::num(ro, "width", def_w), SURROUND_RES_MIN, SURROUND_RES_MAX_W);
			const int res_h = clamp_frame_side(
				js::num(ro, "height", def_h), SURROUND_RES_MIN, SURROUND_RES_MAX_H);
			ro["width"] = res_w;
			ro["height"] = res_h;

			int old_w = def_w, old_h = def_h;
			if (auto* rr = js::obj(cfg, "resolution")) {
				old_w = static_cast<int>(js::num(*rr, "width", old_w));
				old_h = static_cast<int>(js::num(*rr, "height", old_h));
			}
			resolution_changed = (res_w != old_w || res_h != old_h);
		}

		// Смена ширины шва: перепечка весов активной версии на месте
		const double old_blend = js::num(cfg, "blend", TOP_BLEND_DEFAULT);
		double new_blend = old_blend;
		bool blend_changed = false;
		if (auto* b = body.if_contains("blend"); b && b->is_number()) {
			new_blend = b->to_number<double>();
			blend_changed = std::abs(new_blend - old_blend) > 1e-9;
		}

		const bool ok = m_store.mutate_top_block(target,
			[&](boost::json::object& top_obj, std::string&) {
				for (const auto& kv : body) {
					const std::string key(kv.key());
					if (key == "export_id") continue;
					if (kv.value().is_object()) {
						// Группы мёржатся пообъектно, соседние поля не затираются
						boost::json::object group;
						if (auto* g = js::obj(top_obj, key.c_str())) group = *g;
						for (const auto& sub : kv.value().as_object()) {
							group[sub.key()] = sub.value();
						}
						top_obj[key] = std::move(group);
					}
					else {
						top_obj[key] = kv.value();
					}
				}
				return true;
			}, error);
		if (!ok) {
			m_logger.error("set_top(): " + error);
			return false;
		}

		if (blend_changed) {
			auto fresh = m_store.read_export_entry(target);
			UTopBaker baker(&m_logger);
			if (!fresh || !baker.rebake_weights(m_store.exports_root(), *fresh, target,
				static_cast<float>(new_blend), error)) {
				m_logger.error("set_top(): rebake failed: " + error);
				return false;
			}
			dirty |= TOP_DIRTY_WEIGHTS;
		}

		m_logger.info("set_top(): <" + target + "> merged, dirty=" + std::to_string(dirty));

		if (m_running.load() && get_active_export_id() == target
			&& resolve_view_mode() == "top") {
			m_top_dirty.fetch_or(dirty);
			// Размер кадра задан пайплайну при создании, живьём его не сменить
			if (resolution_changed) {
				m_logger.info("set_top(): resolution changed, restarting output");
				if (!restart()) {
					error = "resolution saved, but output restart failed";
					return false;
				}
			}
		}
		return true;
	}

	bool ULinker::get_top(const std::string& export_id,
		boost::json::object& out, std::string& error)
	{
		std::string target = export_id.empty() ? get_active_export_id() : export_id;
		if (target.empty()) {
			error = "no active export";
			return false;
		}

		auto entry = m_store.read_export_entry(target);
		if (!entry) {
			error = "export <" + target + "> not found";
			return false;
		}

		boost::json::object cfg;
		if (auto c = m_store.read_top_cfg(target)) cfg = *c;

		// Дефолты совпадают с печкой и рендерером, поверх - сохранённое
		boost::json::object model{ {"length", 0.0}, {"width", 0.0}, {"height", 0.0},
			{"alpha", 1.0}, {"rotation", 0.0}, {"source", ""} };
		if (const auto* g = js::obj(cfg, "model")) {
			for (const auto& kv : *g) model[kv.key()] = kv.value();
		}

		int def_w = 0, def_h = 0;
		top_natural_size(*entry, resolve_rotation(target), def_w, def_h);
		boost::json::object resolution{ {"width", def_w}, {"height", def_h} };
		if (const auto* g = js::obj(cfg, "resolution")) {
			for (const auto& kv : *g) resolution[kv.key()] = kv.value();
		}

		const std::string active = top_active_version(*entry);

		out["export_id"] = target;
		out["versions"] = top_versions_of(*entry);
		out["active_version"] = active;
		out["generation"] = top_version_generation(active);
		out["current_generation"] = TOP_BAKE_GENERATION;
		if (auto* p = entry->if_contains("preset")) out["preset"] = *p;
		out["blend"] = js::num(cfg, "blend", TOP_BLEND_DEFAULT);
		out["photometric"] = js::flag(cfg, "photometric", true);
		out["plate"] = js::flag(cfg, "plate", true);
		out["plate_length"] = js::num(cfg, "plate_length", 0.0);
		out["plate_width"] = js::num(cfg, "plate_width", 0.0);
		out["model"] = std::move(model);
		out["resolution"] = std::move(resolution);

		// Рисунки экспорта с действующими правками: дефолты из ректа записи
		{
			boost::json::array images_out;
			const auto* overrides = js::obj(cfg, "images");
			if (const auto* imgs = js::arr(*entry, "images")) {
				for (const auto& img_v : *imgs) {
					if (!img_v.is_object()) continue;
					const auto& img = img_v.as_object();
					const std::string img_name = js::str(img, "name");
					const auto* r = js::arr(img, "rect");
					if (img_name.empty() || !r || r->size() != 4) continue;

					const int def_img_w = static_cast<int>(r->at(2).to_number<double>());
					const int def_img_h = static_cast<int>(r->at(3).to_number<double>());
					bool visible = true;
					int img_w = def_img_w;
					int img_h = def_img_h;
					if (const auto* o = overrides
						? js::obj(*overrides, img_name.c_str()) : nullptr) {
						visible = js::flag(*o, "visible", true);
						img_w = static_cast<int>(js::num(*o, "width", def_img_w));
						img_h = static_cast<int>(js::num(*o, "height", def_img_h));
					}

					images_out.push_back(boost::json::object{
						{"name", img_name},
						{"visible", visible},
						{"width", img_w},
						{"height", img_h},
						{"default_width", def_img_w},
						{"default_height", def_img_h} });
				}
			}
			out["images"] = std::move(images_out);
		}

		/*
			Доступность пересчёта считает сервер: ему видно и ключ пресета,
			и src-точки. Фронту остаётся показать кнопку или причину отказа.
		*/
		bool can_recalc = false;
		std::string reason;
		const std::string preset_key = js::str(*entry, "preset");
		if (preset_key.empty()) {
			reason = "export has no preset key, re-export it from the projection page";
		}
		else {
			try {
				std::ifstream f(varan::paths().surround.presets_json);
				std::stringstream ss;
				ss << f.rdbuf();
				auto pv = boost::json::parse(ss.str());
				const auto* preset = pv.is_object()
					? js::obj(pv.as_object(), preset_key.c_str()) : nullptr;
				const auto* cams = preset ? js::obj(*preset, "cameras") : nullptr;
				if (!cams) {
					reason = "preset <" + preset_key + "> not found";
				}
				else {
					can_recalc = true;
					if (const auto* rec_cams = js::obj(*entry, "cameras")) {
						for (const auto& [key, _] : *rec_cams) {
							const auto* cam = js::obj(*cams, std::string(key).c_str());
							const auto* src = cam ? js::arr(*cam, "src_points") : nullptr;
							if (!src || src->size() < 4) {
								can_recalc = false;
								reason = "camera <" + std::string(key) + "> has no saved src points";
								break;
							}
						}
					}
				}
			}
			catch (...) {
				reason = "cannot read presets";
			}
		}
		out["can_recalc"] = can_recalc;
		if (!can_recalc) out["recalc_reason"] = reason;

		return true;
	}

	bool ULinker::set_top_version(const std::string& export_id,
		const std::string& version, std::string& error)
	{
		std::string target = export_id.empty() ? get_active_export_id() : export_id;
		if (target.empty() || version.empty()) {
			error = "export_id and version are required";
			return false;
		}

		auto entry = m_store.read_export_entry(target);
		if (!entry) {
			error = "export <" + target + "> not found";
			return false;
		}

		bool found = false;
		for (const auto& v : top_versions_of(*entry)) {
			if (v.is_object() && js::str(v.as_object(), "key") == version) {
				found = true;
				break;
			}
		}
		if (!found) {
			error = "version <" + version + "> not found";
			return false;
		}

		if (top_active_version(*entry) == version) return true;

		const bool ok = m_store.mutate_export_entry(target,
			[&](boost::json::object& obj, std::string&) {
				obj["active_version"] = version;
				return true;
			}, error);
		if (!ok) {
			m_logger.error("set_top_version(): " + error);
			return false;
		}

		m_logger.info("set_top_version(): <" + target + "> -> " + version);

		// Карты грузятся при создании вывода, живой top пересобирается
		if (m_running.load() && get_active_export_id() == target
			&& resolve_view_mode() == "top") {
			if (!restart()) {
				error = "version saved, but output restart failed";
				return false;
			}
		}
		return true;
	}

	bool ULinker::recalc_top(const std::string& export_id, std::string& error) {
		std::string target = export_id.empty() ? get_active_export_id() : export_id;
		if (target.empty()) {
			error = "export_id is required when output is stopped";
			return false;
		}

		// Привязки мест к камерам: по ним пересчёт ищет записи калибровки
		NCamerasPurpose bindings;
		{
			auto root = m_store.read_state();
			const auto* configs = js::obj(root, "configs");
			const auto* entry = configs ? js::obj(*configs, target.c_str()) : nullptr;
			if (const auto* cams = entry ? js::obj(*entry, "cameras") : nullptr) {
				for (const auto& [k, val] : *cams) {
					if (val.is_string()) bindings[std::string(k)] = std::string(val.as_string().c_str());
					else bindings[std::string(k)] = std::nullopt;
				}
			}
		}

		UTopBaker baker(&m_logger);
		{
			// Печка пишет индекс напрямую, мёржи ручек ждут под замком
			auto lock = m_store.lock_exports();
			if (!baker.recalc_export(m_store.exports_root(), m_store.exports_index_file(),
				target, varan::paths().surround.presets_json,
				varan::paths().surround.calibration_settings, bindings, error)) {
				m_logger.error("recalc_top(): " + error);
				return false;
			}
		}

		m_logger.info("recalc_top(): <" + target + "> done");

		// Новая версия сразу активна, живой top подхватывает её рестартом
		if (m_running.load() && get_active_export_id() == target
			&& resolve_view_mode() == "top") {
			if (!restart()) {
				error = "recalculated, but output restart failed";
				return false;
			}
		}
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

		// 1) Запись в индексе экспортов
		if (!m_store.erase_export_entry(export_id, error)) {
			m_logger.error("delete_export(): " + error);
			return false;
		}

		// 2) Каталог с картами remap и weight
		try {
			const auto dir = m_store.exports_root() / export_id;
			if (std::filesystem::exists(dir)) {
				std::filesystem::remove_all(dir);
			}
		}
		catch (const std::exception& e) {
			error = e.what();
			m_logger.error("delete_export(): " + error);
			return false;
		}

		// 3) Привязки и параметры этой конфигурации
		if (!m_store.erase_state_entry(export_id, error)) {
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

		std::string export_id_copy;
		NCamerasPurpose bindings;
		{
			std::lock_guard<std::mutex> lk(m_mutex);
			export_id_copy = m_export_id;
			bindings = m_cameras_purpose;
		}
		if (export_id_copy.empty()) {
			m_logger.error("processing_loop(): no active export, abort");
			m_context_manager->undone_current(&m_logger);
			return;
		}

		// Режим вывода собирается по view_mode конфигурации
		std::unique_ptr<IOutputMode> mode;
		if (resolve_view_mode() == "surround") {
			mode = std::make_unique<USurroundOutput>(
				m_context_manager, &m_store, export_id_copy, std::move(bindings),
				&m_surround_dirty, &m_surround_mode_request, &m_orbit_manual,
				[this](std::vector<FSurroundBakedCamera> cams) {
					std::lock_guard<std::mutex> lk(m_mutex);
					m_surround_cameras = std::move(cams);
				},
				&m_logger);
		}
		else {
			// В top орбиты нет — статус не должен показывать ручной режим
			m_orbit_manual.store(false);
			mode = std::make_unique<UTopOutput>(
				m_context_manager, &m_store, export_id_copy,
				resolve_rotation(), &m_top_dirty, &m_logger);
		}

		int outW = 0;
		int outH = 0;
		std::string mode_error;
		if (!mode->prepare(outW, outH, mode_error)) {
			m_logger.error("processing_loop(): " + mode_error);
			m_context_manager->undone_current(&m_logger);
			return;
		}

		{
			std::lock_guard<std::mutex> lk(m_mutex);
			m_out_width = outW;
			m_out_height = outH;
			m_camera_keys = mode->camera_keys();
		}

		if (!m_context_manager->init_render_framebuffer(outW, outH, &m_logger)) {
			m_logger.error("processing_loop(): cannot init render FBO");
			m_context_manager->undone_current(&m_logger);
			return;
		}

		if (m_websocket.ip_adress.empty() || m_websocket.port.empty()) {
			m_logger.error("processing_loop(): websocket is incorrect, aborted starting connection!");
			m_context_manager->undone_current(&m_logger);
			return;
		}

		// Идентификатор и частота из настроек активной конфигурации;
		// без них остаются значения по умолчанию
		const auto params = get_stream_params();
		m_stream_id = params.stream_id;
		fps = params.fps;

		auto camera = std::make_unique<USurroundCamera>(m_stream_id, m_websocket);
		mode->bind_camera(*camera);
		m_streamer = std::move(camera);

		// Отказ на старте сносит камеру сразу: её колбэки держат режим на стеке
		auto drop_streamer = [this] {
			m_streamer->stop();
			m_streamer.reset();
		};
		if (!m_streamer->set_parameters(outW, outH, fps)) {
			m_logger.error("processing_loop(): streamer set_parameters failed");
			drop_streamer();
			m_context_manager->undone_current(&m_logger);
			return;
		}
		if (!m_streamer->initialize()) {
			m_logger.error("processing_loop(): streamer initialize failed");
			drop_streamer();
			m_context_manager->undone_current(&m_logger);
			return;
		}
		if (!m_streamer->start()) {
			m_logger.error("processing_loop(): streamer start failed");
			drop_streamer();
			m_context_manager->undone_current(&m_logger);
			return;
		}
		m_logger.info("processing_loop(): streamer started, stream_id=" + m_stream_id);

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

			// Перепечка меняет состав камер — пространство пересоздаётся
			if (mode->apply_live_changes()) {
				{
					std::lock_guard<std::mutex> lk(m_mutex);
					m_camera_keys = mode->camera_keys();
				}
				space = create_linking_space();
			}

			fill_linking_space(space);
			mode->render_frame(space, dt, m_context_manager->get_display());

			glReadPixels(0, 0, outW, outH, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());

			cv::Mat img(outH, outW, CV_8UC4, pixels.data());
			if (m_streamer) m_streamer->push_frame(img);

			stats_work_ms += std::chrono::duration<double, std::milli>(clock::now() - work_start).count();
			++stats_frames;

			const auto stats_elapsed = std::chrono::duration<double>(clock::now() - stats_start).count();
			if (stats_elapsed >= 5.0 && stats_frames > 0) {
				const int fps10 = static_cast<int>(stats_frames / stats_elapsed * 10.0 + 0.5);
				const int work10 = static_cast<int>(stats_work_ms / stats_frames * 10.0 + 0.5);
				m_logger.info("processing_loop(): fps=" + std::to_string(fps10 / 10) + "." + std::to_string(fps10 % 10)
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

		m_context_manager->undone_current(&m_logger);
	}

	std::filesystem::path ULinker::get_configurations_path() {
		return varan::paths().surround.presets_json;
	}

	std::filesystem::path ULinker::get_exports_index_path() const {
		return m_store.exports_index_path();
	}

	std::filesystem::path ULinker::get_images_list_path() {
		return varan::paths().surround.presets_images;
	}

	std::filesystem::path ULinker::get_models_list_path() {
		return varan::paths().surround.presets_models;
	}

}; // birdview
}; // varan
