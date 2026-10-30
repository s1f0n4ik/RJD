#include "bird-view/linker-config.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <fstream>
#include <limits>
#include <set>
#include <sstream>
#include <stdexcept>

#include <opencv2/calib3d.hpp>

#include "bird-view/top-bake.h"
#include "calibration/utility.h"
#include "core/machine-config.h"
#include "core/paths.h"

namespace varan::birdview {
	namespace {

		const FSurroundField SURROUND_FIELDS[] = {
			{ "machine", "length", EFieldKind::NumPositive,   LINKER_CONFIG_GEOMETRY },
			{ "machine", "width",  EFieldKind::NumPositive,   LINKER_CONFIG_GEOMETRY },
			{ "machine", "height", EFieldKind::NumPositive,   LINKER_CONFIG_GEOMETRY },
			{ "bowl", "floor",     EFieldKind::NumPositive,   LINKER_CONFIG_GEOMETRY },
			{ "bowl", "wall",      EFieldKind::NumPositive,   LINKER_CONFIG_GEOMETRY },
			{ "bowl", "plate",     EFieldKind::NumPositive,   LINKER_CONFIG_GEOMETRY },
			{ "bowl", "blend",     EFieldKind::NumPositive,   LINKER_CONFIG_GEOMETRY },
			// Ноль допустим: вертикальная стенка и прямые углы
			{ "bowl", "outer",     EFieldKind::NumNonNegative, LINKER_CONFIG_GEOMETRY },
			{ "bowl", "corner",    EFieldKind::NumNonNegative, LINKER_CONFIG_GEOMETRY },
			{ "orbit", "distance", EFieldKind::NumPositive,   LINKER_CONFIG_VISUAL },
			// Высота глаза в метрах, ноль - уровень пола; наклон в градусах, плюс вниз
			{ "orbit", "height",   EFieldKind::NumNonNegative, LINKER_CONFIG_VISUAL },
			{ "orbit", "pitch",    EFieldKind::NumAny,        LINKER_CONFIG_VISUAL },
			{ "orbit", "speed",    EFieldKind::NumNonNegative, LINKER_CONFIG_VISUAL },
			// Дефолт ручного управления на отображении, применяется и живьём
			{ "orbit", "interactive", EFieldKind::Flag,       LINKER_CONFIG_VISUAL },
			{ "model", "length",   EFieldKind::NumNonNegative, LINKER_CONFIG_VISUAL },
			{ "model", "width",    EFieldKind::NumNonNegative, LINKER_CONFIG_VISUAL },
			{ "model", "height",   EFieldKind::NumNonNegative, LINKER_CONFIG_VISUAL },
			{ "model", "alpha",    EFieldKind::NumAlpha,      LINKER_CONFIG_VISUAL },
			{ "model", "rotation", EFieldKind::NumAny,        LINKER_CONFIG_VISUAL },
			{ "model", "source",   EFieldKind::SourceName,    LINKER_CONFIG_VISUAL },
			// Множитель к вписыванию в габарит; работает, пока stretch выключен
			{ "model", "scale",    EFieldKind::NumPositive,   LINKER_CONFIG_VISUAL },
			// Каждая сторона тянется своей величиной, вписывание не равномерное
			{ "model", "stretch",  EFieldKind::Flag,          LINKER_CONFIG_VISUAL },
			{ nullptr, "plate",       EFieldKind::Flag,           LINKER_CONFIG_VISUAL },
			{ nullptr, "wireframe",   EFieldKind::Flag,           LINKER_CONFIG_VISUAL },
			{ nullptr, "photometric", EFieldKind::Flag,           LINKER_CONFIG_VISUAL },
			{ nullptr, "plate_length", EFieldKind::NumNonNegative, LINKER_CONFIG_VISUAL },
			{ nullptr, "plate_width",  EFieldKind::NumNonNegative, LINKER_CONFIG_VISUAL },
		};

		const FSurroundField TOP_FIELDS[] = {
			{ "model", "length",   EFieldKind::NumNonNegative, LINKER_CONFIG_VISUAL },
			{ "model", "width",    EFieldKind::NumNonNegative, LINKER_CONFIG_VISUAL },
			{ "model", "height",   EFieldKind::NumNonNegative, LINKER_CONFIG_VISUAL },
			{ "model", "alpha",    EFieldKind::NumAlpha,       LINKER_CONFIG_VISUAL },
			{ "model", "rotation", EFieldKind::NumAny,         LINKER_CONFIG_VISUAL },
			{ "model", "source",   EFieldKind::SourceName,     LINKER_CONFIG_VISUAL },
			{ "model", "scale",    EFieldKind::NumPositive,    LINKER_CONFIG_VISUAL },
			{ "model", "stretch",  EFieldKind::Flag,           LINKER_CONFIG_VISUAL },
			// Ширина шва применяется перепечкой весов, не dirty-флагом
			{ nullptr, "blend",        EFieldKind::NumPositive,    0 },
			{ nullptr, "photometric",  EFieldKind::Flag,           LINKER_CONFIG_VISUAL },
			{ nullptr, "plate",        EFieldKind::Flag,           LINKER_CONFIG_VISUAL },
			{ nullptr, "plate_length", EFieldKind::NumNonNegative, LINKER_CONFIG_VISUAL },
			{ nullptr, "plate_width",  EFieldKind::NumNonNegative, LINKER_CONFIG_VISUAL },
		};


		boost::json::object read_object(const std::filesystem::path& path) {
			if (!std::filesystem::exists(path)) return {};
			std::ifstream file(path);
			if (!file) throw std::runtime_error("cannot read " + path.string());
			std::stringstream data;
			data << file.rdbuf();
			auto value = boost::json::parse(data.str());
			if (!value.is_object()) throw std::runtime_error(path.string() + " must contain an object");
			return value.as_object();
		}

		void strip_image_paths(boost::json::object& entry) {
			if (auto* images = entry.if_contains("images"); images && images->is_array())
				for (auto& image : images->as_array())
					if (image.is_object()) image.as_object().erase("path");
		}

		boost::json::object projection_source(boost::json::object entry) {
			for (const char* key : { "width", "height", "versions", "active_version", "_assets" }) entry.erase(key);
			if (auto* cameras = entry.if_contains("cameras"); cameras && cameras->is_object())
				for (auto& camera : cameras->as_object())
					if (camera.value().is_object())
						for (const char* key : { "remap", "weight", "region", "center", "region_poly" })
							camera.value().as_object().erase(key);
			strip_image_paths(entry);
			return entry;
		}

		boost::json::object projection_geometry(boost::json::object entry) {
			entry = projection_source(std::move(entry));
			for (const char* key : { "name", "surround", "top" }) entry.erase(key);
			return entry;
		}

		boost::json::object calibration_geometry(const boost::json::object& entries) {
			boost::json::object result;
			for (const auto& kv : entries) {
				if (!kv.value().is_object()) throw std::runtime_error("calibration must be an object");
				boost::json::object geometry;
				for (const char* key : { "id", "width", "height", "camera_matrix", "distortion_coeffs", "new_K" })
					if (const auto* value = kv.value().as_object().if_contains(key)) geometry[key] = *value;
				result[kv.key()] = std::move(geometry);
			}
			return result;
		}

		boost::json::object with_derived(const boost::json::object& source, const boost::json::object& derived) {
			auto entry = projection_source(source);
			for (const char* key : { "width", "height", "versions", "active_version" })
				if (const auto* value = derived.if_contains(key)) entry[key] = *value;
			if (auto* cameras = entry.if_contains("cameras"); cameras && cameras->is_object())
				for (auto& camera : cameras->as_object())
					if (camera.value().is_object())
						if (const auto* old = js::obj(derived, "cameras"))
							if (const auto* c = js::obj(*old, std::string(camera.key()).c_str()))
								for (const char* key : { "remap", "weight", "region", "center", "region_poly" })
									if (const auto* value = c->if_contains(key)) camera.value().as_object()[key] = *value;
			return entry;
		}

		const boost::json::value& field(const boost::json::object& object, const char* key) {
			static const boost::json::value empty;
			if (const auto* value = object.if_contains(key)) return *value;
			return empty;
		}

		bool valid_id(const std::string& id) {
			return !id.empty() && std::all_of(id.begin(), id.end(), [](unsigned char c) {
				return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
					|| (c >= '0' && c <= '9') || c == '_' || c == '-';
			});
		}

		bool valid_file(const std::string& name) {
			return !name.empty() && name.find_first_of("/\\") == std::string::npos
				&& name.find("..") == std::string::npos && name != ".";
		}

		std::string validate_settings(const boost::json::object& settings, std::span<const FSurroundField> rules) {
			std::string error;
			for (const auto& rule : rules) {
				const auto* group = rule.group ? js::obj(settings, rule.group) : &settings;
				if (rule.group && settings.contains(rule.group) && !group) return std::string(rule.group) + " must be an object";
				if (group)
					if (const auto* value = group->if_contains(rule.key))
						if (!check_surround_field(rule, *value, error)) return error;
			}
			for (const char* key : { "resolution", "calibration", "extrinsics", "images" }) {
				const auto* value = settings.if_contains(key);
				if (!value) continue;
				if (!value->is_object()) return std::string(key) + " must be an object";
				for (const auto& item : value->as_object()) {
					if (std::string(key) == "calibration") {
						if (!item.value().is_string()) return "calibration values must be strings";
					}
					else if (std::string(key) == "resolution") {
						if (!item.value().is_number() || !std::isfinite(item.value().to_number<double>())
							|| item.value().to_number<double>() <= 0) return "resolution must be positive";
					}
					else if (!item.value().is_object()) return std::string(key) + " values must be objects";
					else if (std::string(key) == "extrinsics") {
						const auto& pose = item.value().as_object();
						const auto* position = js::arr(pose, "position");
						if (!position || position->size() != 3) return "camera position must have three coordinates";
						for (const auto& coordinate : *position)
							if (!coordinate.is_number() || !std::isfinite(coordinate.to_number<double>())) return "camera position must be finite";
						for (const char* angle : { "yaw", "pitch", "roll" })
							if (const auto* number = pose.if_contains(angle))
								if (!number->is_number() || !std::isfinite(number->to_number<double>())) return "camera angles must be finite";
					}
				}
			}
			return {};
		}

		std::string build_maps(const boost::json::object& entry,
			const std::filesystem::path& map_x, const std::filesystem::path& map_y) {
			using calibration::utility::SBinary;
			const auto* k = js::obj(entry, "camera_matrix");
			const auto* d = js::obj(entry, "distortion_coeffs");
			const auto* p = js::obj(entry, "new_K");
			const int width = static_cast<int>(js::num(entry, "width", 0));
			const int height = static_cast<int>(js::num(entry, "height", 0));
			if (!k || !d || !p || width <= 0 || height <= 0)
				return "camera_matrix, distortion_coeffs, new_K and size are required";
			cv::Mat mx, my;
			cv::fisheye::initUndistortRectifyMap(SBinary::json_object_to_mat(*k),
				SBinary::json_object_to_mat(*d), cv::Mat::eye(3, 3, CV_64F),
				SBinary::json_object_to_mat(*p), cv::Size(width, height), CV_16SC2, mx, my);
			if (!SBinary::save_mat_to_binary(map_x, mx, nullptr)
				|| !SBinary::save_mat_to_binary(map_y, my, nullptr)) return "cannot write undistort maps";
			return {};
		}

		std::set<std::string> changed_entries(const boost::json::object& before, const boost::json::object& after) {
			std::set<std::string> changed;
			for (const auto& kv : after)
				if (const auto* old = before.if_contains(kv.key()); !old || *old != kv.value())
					changed.insert(std::string(kv.key()));
			for (const auto& kv : before)
				if (!after.contains(kv.key())) changed.insert(std::string(kv.key()));
			return changed;
		}

	}

	std::span<const FSurroundField> surround_fields() { return SURROUND_FIELDS; }
	std::span<const FSurroundField> top_fields() { return TOP_FIELDS; }

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
			if (!std::isfinite(d)) {
				error = name + " must be finite";
				return false;
			}
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

	ULinkerConfig::ULinkerConfig(ULinkerStore& store, ULogger* logger,
		CPrepareLinkerConfig prepare, CApplyLinkerConfig apply)
		: m_store(store), m_logger(logger), m_prepare(std::move(prepare)), m_apply(std::move(apply)) {}

	std::string ULinkerConfig::apply(const boost::json::value& part, bool running) {
		try {
			if (!part.is_object()) return "surround must be an object";
			const auto& body = part.as_object();
			for (const char* key : { "calibrations", "links", "presets", "projections", "output" })
				if (!js::obj(body, key)) return std::string("surround needs object <") + key + ">";
			const auto& calibrations = body.at("calibrations").as_object();
			const auto& links = body.at("links").as_object();
			const auto& presets = body.at("presets").as_object();
			const auto& projections = body.at("projections").as_object();
			const auto& output = body.at("output").as_object();
			const auto* configs = js::obj(output, "configs");
			if (!configs) return "output needs configs";
			const auto* active = output.if_contains("active");
			if (!active || (!active->is_string() && !active->is_null())) return "output active must be a string or null";
			const std::string active_new = js::str(output, "active");
			if (!active_new.empty() && (!projections.contains(active_new) || !configs->contains(active_new)))
				return "active output must reference a projection and configuration";

			const auto& paths = varan::paths().surround;
			const auto pending_path = paths.linker_state_root / "config-pending.json";
			const auto pending = read_object(pending_path);
			const auto calib_now = read_object(paths.calibration_settings);
			const auto presets_disk = read_object(paths.presets_json);
			auto presets_now = presets_disk;
			for (auto& kv : presets_now) if (kv.value().is_object()) strip_image_paths(kv.value().as_object());
			const auto exports_now = read_object(m_store.exports_index_path());
			read_object(m_store.state_path());
			const auto state_now = m_store.read_state();
			const std::string active_now = js::str(state_now, "active");
			const auto* old_configs = js::obj(state_now, "configs");
			boost::json::object calib_new, presets_new, exports_new, configs_new;
			std::map<std::string, std::string> assets;
			std::set<std::string> replaced_assets, maps_needed, recalc, rebake;
			FLinkerConfigUpdate update;
			update.resume = running || js::flag(pending, "resume", false);
			update.restart = js::flag(pending, "restart", false);
			if (const auto* queued = js::arr(pending, "recalc"))
				for (const auto& id : *queued) if (id.is_string() && projections.contains(id.as_string())) recalc.insert(id.as_string().c_str());
			if (const auto* queued = js::arr(pending, "rebake"))
				for (const auto& id : *queued) if (id.is_string() && projections.contains(id.as_string())) rebake.insert(id.as_string().c_str());
			if (const auto* changes = js::obj(pending, "changes"))
				for (const auto& kv : *changes) update.changes[std::string(kv.key())] = kv.value().to_number<unsigned>();

			for (const auto* group : { &calibrations, &presets, &projections }) {
				for (const auto& kv : *group) {
					if (!kv.value().is_object()) return "entry <" + std::string(kv.key()) + "> must be an object";
					if (group != &presets && !valid_id(std::string(kv.key()))) return "invalid entry id <" + std::string(kv.key()) + ">";
					const auto& entry = kv.value().as_object();
					if (entry.contains("_assets") && !js::obj(entry, "_assets")) return "_assets must be an object";
					if (const auto* cameras = js::obj(entry, "cameras"))
						for (const auto& camera : *cameras)
							if (!valid_id(std::string(camera.key())) || !camera.value().is_object()) return "invalid camera place";
					if (group == &projections) {
						for (const auto& [mode, rules] : std::map<std::string, std::span<const FSurroundField>>{
							{ "surround", surround_fields() }, { "top", top_fields() } }) {
							const auto* settings = entry.if_contains(mode);
							if (!settings) continue;
							if (!settings->is_object()) return mode + " must be an object";
							if (auto error = validate_settings(settings->as_object(), rules); !error.empty()) return mode + ": " + error;
						}
					}
					if (const auto* files = js::obj(kv.value().as_object(), "_assets")) {
						for (const auto& file : *files) {
							const std::string name(file.key());
							if (!valid_file(name) || !file.value().is_string()) return "invalid asset <" + name + ">";
							const std::string sha(file.value().as_string());
							if (sha.size() != 64 || sha.find_first_not_of("0123456789abcdef") != std::string::npos) return "invalid asset sha256";
							if (auto previous = assets.find(name); previous != assets.end() && previous->second != sha) return "conflicting asset <" + name + ">";
							assets[name] = sha;
							const auto dir = name.ends_with(".glb") ? paths.presets_models : paths.presets_images;
							if (sha256_file(dir / name) != sha) {
								if (sha256_file(varan::paths().config.assets / sha) != sha) return "asset " + sha + " is missing or corrupt";
								replaced_assets.insert(name);
							}
						}
					}
				}
			}
			for (const auto& kv : calibrations) {
				auto entry = kv.value().as_object();
				entry.erase("_assets");
				for (const char* key : { "width", "height" }) {
					const auto* size = entry.if_contains(key);
					if (!size || !size->is_number() || !std::isfinite(size->to_number<double>())
						|| size->to_number<double>() <= 0 || size->to_number<double>() > std::numeric_limits<int>::max()) return "invalid calibration size";
				}
				for (const char* key : { "camera_matrix", "distortion_coeffs", "new_K" }) {
					const auto* matrix = entry.if_contains(key);
					if (!matrix) continue;
					if (!matrix->is_object()) return std::string(key) + " must be a matrix";
					const auto value = calibration::utility::SBinary::json_object_to_mat(matrix->as_object());
					if (value.depth() != CV_64F || value.channels() != 1 || !cv::checkRange(value)) return "invalid calibration matrix values";
					if (std::string(key) == "distortion_coeffs") {
						if (value.total() != 4) return "distortion_coeffs must have four values";
					}
					else if (value.rows != 3 || value.cols != 3) return std::string(key) + " must be 3x3";
				}
				if (entry.contains("new_K")) {
					const std::string key(kv.key());
					const auto x = paths.calibration_maps / (key + "_map_x.bin");
					const auto y = paths.calibration_maps / (key + "_map_y.bin");
					entry["undist_map_x"] = x.filename().string();
					entry["undist_map_y"] = y.filename().string();
					const auto* before = js::obj(calib_now, key.c_str());
					bool changed = !before || !std::filesystem::exists(x) || !std::filesystem::exists(y);
					for (const char* field_name : { "width", "height", "camera_matrix", "distortion_coeffs", "new_K" })
						changed = changed || (before && field(*before, field_name) != field(entry, field_name));
					if (changed) maps_needed.insert(key);
				}
				calib_new[kv.key()] = std::move(entry);
			}
			for (const auto& kv : presets) {
				auto entry = kv.value().as_object();
				entry.erase("_assets");
				strip_image_paths(entry);
				presets_new[kv.key()] = std::move(entry);
			}
			for (const auto& kv : links) {
				if (!kv.value().is_object()) return "correction link must be an object";
				const auto& link = kv.value().as_object();
				const auto key = js::str(link, "config");
				if (key.empty() || !calib_new.contains(key)) return "correction link must reference a calibration";
				if (const auto* fps = link.if_contains("fps"); fps && ((!fps->is_int64() && !fps->is_uint64())
					|| fps->to_number<double>() < 1 || fps->to_number<double>() > 60)) return "correction fps must be within 1..60";
			}
			const auto calib_changed = changed_entries(calibration_geometry(calib_now), calibration_geometry(calib_new));
			const auto presets_changed = changed_entries(presets_now, presets_new);
			for (const auto& kv : *configs) {
				const std::string id(kv.key());
				if (!projections.contains(id) || !kv.value().is_object()) return "output <" + id + "> must reference a projection";
				auto entry = kv.value().as_object();
				if (const auto* fps = entry.if_contains("fps"); fps && ((!fps->is_int64() && !fps->is_uint64())
					|| fps->to_number<double>() < 1 || fps->to_number<double>() > 60)) return "output fps must be an integer within 1..60";
				if (const auto* angle = entry.if_contains("rotation"); angle && (!angle->is_number()
					|| (angle->to_number<double>() != 0 && angle->to_number<double>() != 90
						&& angle->to_number<double>() != 180 && angle->to_number<double>() != 270))) return "invalid output rotation";
				if (const auto* dual = entry.if_contains("dual_output"); dual && !dual->is_bool()) return "dual_output must be a bool";
				entry.erase("view_mode");
				if (const auto* before = old_configs ? js::obj(*old_configs, id.c_str()) : nullptr)
					if (const auto* mode = before->if_contains("view_mode")) entry["view_mode"] = *mode;
				configs_new[id] = std::move(entry);
			}
			boost::json::object state_new{ { "active", active_new }, { "configs", configs_new } };
			for (const auto& kv : projections) {
				const std::string id(kv.key());
				const auto src = projection_source(kv.value().as_object());
				const auto* before = js::obj(exports_now, id.c_str());
				const auto* previous_output = old_configs ? js::obj(*old_configs, id.c_str()) : nullptr;
				const auto* next_output = js::obj(configs_new, id.c_str());
				bool geometry = !before || projection_geometry(*before) != projection_geometry(src)
					|| presets_changed.contains(js::str(src, "preset"));
				if (before) {
					for (const char* block : { "surround", "top" }) {
						const auto* old_block = js::obj(*before, block);
						const auto* new_block = js::obj(src, block);
						const boost::json::object empty;
						if (field(old_block ? *old_block : empty, "calibration")
							!= field(new_block ? *new_block : empty, "calibration")) geometry = true;
					}
				}
				if (previous_output && next_output && field(*previous_output, "cameras") != field(*next_output, "cameras")) geometry = true;
				std::set<std::string> used_calibrations;
				for (const char* block : { "surround", "top" })
					if (const auto* settings = js::obj(src, block))
						if (const auto* map = js::obj(*settings, "calibration"))
							for (const auto& item : *map) if (item.value().is_string()) used_calibrations.insert(item.value().as_string().c_str());
				if (const auto* preset = js::obj(presets_new, js::str(src, "preset").c_str()))
					if (const auto* cameras = js::obj(*preset, "cameras"))
						for (const auto& camera : *cameras)
							if (camera.value().is_object()) used_calibrations.insert(js::str(camera.value().as_object(), "calibration"));
				for (const auto& key : used_calibrations) geometry = geometry || calib_changed.contains(key) || maps_needed.contains(key);
				std::set<std::string> used_cameras;
				if (next_output)
					if (const auto* bindings = js::obj(*next_output, "cameras"))
						for (const auto& binding : *bindings)
							if (binding.value().is_string()) used_cameras.insert(binding.value().as_string().c_str());
				for (const auto& key : calib_changed) {
					const auto* old_calibration = js::obj(calib_now, key.c_str());
					const auto* new_calibration = js::obj(calib_new, key.c_str());
					if ((old_calibration && used_cameras.contains(js::str(*old_calibration, "id")))
						|| (new_calibration && used_cameras.contains(js::str(*new_calibration, "id")))) geometry = true;
				}
				if (geometry) recalc.insert(id);
				auto entry = src;
				if (before) {
					if (projection_source(*before) == src) entry = *before;
					else entry = with_derived(src, *before);
					if (!recalc.contains(id) && top_version_generation(top_active_version(*before)) < TOP_BAKE_GENERATION
						&& field(*before, "top") != field(src, "top")) return "top settings need current generation maps; recalculate the export first";
				}
				exports_new[id] = std::move(entry);
				if (id != active_now && id != active_new) continue;
				if (geometry) update.restart = true;
				for (const char* mode : { "surround", "top" }) {
					const auto* old_settings = before ? js::obj(*before, mode) : nullptr;
					const auto* new_settings = js::obj(src, mode);
					if ((old_settings != nullptr) != (new_settings != nullptr)) update.restart = true;
					if (before && field(*before, mode) == field(src, mode)) continue;
					update.changes[mode] |= LINKER_CONFIG_VISUAL;
					if (std::string(mode) == "surround" && old_settings && new_settings) {
						for (const char* key : { "machine", "bowl", "extrinsics", "calibration", "preset" })
							if (field(*old_settings, key) != field(*new_settings, key)) update.changes[mode] |= LINKER_CONFIG_GEOMETRY;
						const auto* old_orbit = js::obj(*old_settings, "orbit");
						const auto* new_orbit = js::obj(*new_settings, "orbit");
						const bool manual_before = old_orbit && js::flag(*old_orbit, "interactive", false);
						const bool manual_after = new_orbit && js::flag(*new_orbit, "interactive", false);
						if (manual_before != manual_after) update.changes[mode] |= LINKER_CONFIG_ORBIT;
					}
					if (old_settings && new_settings && field(*old_settings, "resolution") != field(*new_settings, "resolution")) update.restart = true;
				}
			}
			for (const auto& kv : projections) {
				const std::string id(kv.key());
				const auto* old = js::obj(exports_now, id.c_str());
				const auto* old_top = old ? js::obj(*old, "top") : nullptr;
				const auto* new_top = js::obj(kv.value().as_object(), "top");
				const double old_blend = old_top ? js::num(*old_top, "blend", TOP_BLEND_DEFAULT) : TOP_BLEND_DEFAULT;
				const double new_blend = new_top ? js::num(*new_top, "blend", TOP_BLEND_DEFAULT) : TOP_BLEND_DEFAULT;
				if (old_blend != new_blend) {
					rebake.insert(id);
					if (id == active_now || id == active_new) update.changes["top"] |= LINKER_CONFIG_GEOMETRY;
				}
				bool files_changed = false;
				if (const auto* files = js::obj(kv.value().as_object(), "_assets"))
					for (const auto& file : *files) files_changed = files_changed || replaced_assets.contains(std::string(file.key()));
				if (const auto* preset = js::obj(presets, js::str(kv.value().as_object(), "preset").c_str()))
					if (const auto* files = js::obj(*preset, "_assets"))
						for (const auto& file : *files) files_changed = files_changed || replaced_assets.contains(std::string(file.key()));
				if ((id == active_now || id == active_new) && (files_changed || recalc.contains(id))) update.restart = true;
			}
			if (active_now != active_new || (active_now.empty() != active_new.empty())) update.restart = true;
			if (!active_new.empty() && old_configs && field(*old_configs, active_new.c_str()) != field(configs_new, active_new.c_str())) update.restart = true;
			const bool changed = calib_now != calib_new || !maps_needed.empty() || presets_now != presets_new
				|| exports_now != exports_new || state_now != state_new || !replaced_assets.empty()
				|| read_object(paths.calibration_links) != links || !pending.empty();
			if (!changed) return {};
			boost::json::array recalc_json, rebake_json;
			for (const auto& id : recalc) recalc_json.emplace_back(id);
			for (const auto& id : rebake) rebake_json.emplace_back(id);
			boost::json::object changes;
			for (const auto& [mode, flags] : update.changes) changes[mode] = flags;
			const boost::json::object journal{ { "recalc", recalc_json }, { "rebake", rebake_json },
				{ "restart", update.restart }, { "resume", update.resume }, { "changes", changes } };
			if (auto error = write_durable(pending_path, boost::json::serialize(journal)); !error.empty()) return error;
			m_prepare(update);
			for (const auto& [name, sha] : assets) {
				bool replaced = false;
				const auto dir = name.ends_with(".glb") ? paths.presets_models : paths.presets_images;
				if (auto error = place_asset(dir / name, sha, replaced); !error.empty()) return error;
			}
			for (const auto& key : maps_needed) {
				if (auto error = build_maps(calib_new.at(key).as_object(),
					paths.calibration_maps / (key + "_map_x.bin"), paths.calibration_maps / (key + "_map_y.bin")); !error.empty()) return error;
			}
			for (const auto& [path, value] : std::vector<std::pair<std::filesystem::path, boost::json::object>>{
				{ paths.calibration_settings, calib_new }, { paths.calibration_links, links },
				{ paths.presets_json, presets_new }, { m_store.exports_index_path(), exports_new }, { m_store.state_path(), state_new } }) {
				std::unique_lock<std::mutex> lock;
				if (path == m_store.exports_index_path()) lock = m_store.lock_exports();
				auto before = read_object(path);
				if (path == paths.presets_json) for (auto& kv : before) if (kv.value().is_object()) strip_image_paths(kv.value().as_object());
				if (before == value) continue;
				if (auto error = write_durable(path, boost::json::serialize(value)); !error.empty()) return error;
			}
			UTopBaker baker(m_logger);
			for (const auto& id : recalc) {
				std::unordered_map<std::string, std::optional<std::string>> bindings;
				if (const auto* config = js::obj(configs_new, id.c_str()))
					if (const auto* cameras = js::obj(*config, "cameras"))
						for (const auto& kv : *cameras) bindings[std::string(kv.key())] = kv.value().is_string()
							? std::optional<std::string>(kv.value().as_string().c_str()) : std::nullopt;
				std::string error;
				auto lock = m_store.lock_exports();
				if (!baker.recalc_export(m_store.exports_root(), m_store.exports_index_file(), id,
					paths.presets_json, paths.calibration_settings, bindings, error)) return "projection <" + id + ">: " + error;
			}
			for (const auto& id : rebake) {
				if (recalc.contains(id)) continue;
				const auto entry = m_store.read_export_entry(id);
				const auto* top = entry ? js::obj(*entry, "top") : nullptr;
				std::string error;
				auto lock = m_store.lock_exports();
				if (!entry || !baker.rebake_weights(m_store.exports_root(), *entry, id,
					static_cast<float>(top ? js::num(*top, "blend", TOP_BLEND_DEFAULT) : TOP_BLEND_DEFAULT), error)) return "projection <" + id + ">: " + error;
			}
			if (!recalc.empty()) {
				auto lock = m_store.lock_exports();
				auto baked = read_object(m_store.exports_index_path());
				const auto before = baked;
				for (const auto& id : recalc)
					baked[id] = with_derived(projections.at(id).as_object(), baked.at(id).as_object());
				if (baked != before)
					if (auto error = write_durable(m_store.exports_index_path(), boost::json::serialize(baked)); !error.empty()) return error;
			}
			if (auto error = m_apply(update); !error.empty()) return error;
			for (const auto& kv : exports_now) {
				if (projections.contains(kv.key()) || !valid_id(std::string(kv.key()))) continue;
				std::error_code ec;
				std::filesystem::remove_all(m_store.exports_root() / std::string(kv.key()), ec);
				if (ec) return "cannot remove projection <" + std::string(kv.key()) + ">: " + ec.message();
			}
			std::filesystem::remove(pending_path);
			if (m_logger) m_logger->info("apply_config(): surround applied, recalc " + std::to_string(recalc.size()));
			return {};
		}
		catch (const std::exception& error) {
			return error.what();
		}
	}

}
