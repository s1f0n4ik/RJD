#pragma once

#include <vector>
#include <optional>

#include <opencv2/core.hpp>

#include "utility/json-reader.h"
#include "utility.h"
#include "constants.h"

using namespace varan::calibration::utility;

namespace varan {
namespace calibration {

	/*
		Конфигурация проекций (склейки) камер на общий канвас.

		{
			"<preset_key>": {
				"name": "Truck 3.4x25m — 6 cameras",
				"canvas": { "width": 570, "height": 1850 },
				"cameras": {
					"front": {
						"name": "Front",
						"src_points": [[x,y], ...],     # на изображении камеры (после undist)
						"dst_points": [[X,Y], ...]      # АБСОЛЮТНЫЕ координаты канваса
					},
					...
				}
			}
		}

		Сами warp-карты в этом файле НЕ хранятся — они живут в UCalibrator во время
		склейки и сохраняются отдельно через калибровочную конфигурацию.
	*/

	class UJsonProjectionConfiguration : public UJsonReaderBase {
	public:
		explicit UJsonProjectionConfiguration(ULogger* logger = nullptr)
			: UJsonReaderBase(logger) {}

		// ===== Чтение пресетов в удобные структуры =====

		std::optional<FProjectionPreset> load_preset(const std::string& preset_key) const {
			try {
				auto it = m_json.find(preset_key);
				if (it == m_json.end() || !it->value().is_object()) {
					log_error("load_preset(): preset <" + preset_key + "> not found");
					return std::nullopt;
				}

				const auto& obj = it->value().as_object();
				FProjectionPreset preset;
				preset.key = preset_key;

				if (auto* name = obj.if_contains(constants::PROJ_NAME)) {
					if (name->is_string()) preset.name = name->as_string().c_str();
				}

				if (auto* canvas = obj.if_contains(constants::PROJ_CANVAS); canvas && canvas->is_object()) {
					preset.canvas_size = parse_size(canvas->as_object());
				}

				auto* cameras = obj.if_contains(constants::PROJ_CAMERAS);
				if (!cameras || !cameras->is_object()) {
					log_warn("load_preset(): preset <" + preset_key + "> has no cameras");
					return preset;
				}

				for (const auto& [cam_key, cam_value] : cameras->as_object()) {
					if (!cam_value.is_object()) continue;

					std::string camera_key(cam_key);
					//if (!is_valid_position(camera_key)) {
					//	log_warn("load_preset(): unknown camera camera_key <" + camera_key + "> — skipped");
					//	continue;
					//}

					auto cam = parse_camera(camera_key, cam_value.as_object());
					if (cam.has_value()) {
						preset.cameras.emplace(camera_key, std::move(*cam));
					}
				}

				return preset;
			}
			catch (const std::exception& error) {
				log_error("load_preset(): " + std::string(error.what()));
				return std::nullopt;
			}
		}

		// Список пресетов (key + name) для отдачи клиенту.
		boost::json::array list_presets() const {
			boost::json::array result;
			for (const auto& [key, value] : m_json) {
				if (!value.is_object()) continue;
				boost::json::object item;
				item[constants::JSON_CONFIG_KEY] = key;
				if (auto* name = value.as_object().if_contains(constants::PROJ_NAME); name && name->is_string()) {
					item[constants::PROJ_NAME] = *name;
				}
				result.push_back(item);
			}
			return result;
		}

		// ===== Запись пресета из структуры в json =====

		bool save_preset(const FProjectionPreset& preset) {
			try {
				boost::json::object obj;
				obj[constants::PROJ_NAME] = preset.name;
				obj[constants::PROJ_CANVAS] = serialize_size(preset.canvas_size);

				boost::json::object cameras_obj;
				for (const auto& [position, cam] : preset.cameras) {
					if (!is_valid_position(position)) {
						log_warn("save_preset(): drop unknown camera_key <" + position + ">");
						continue;
					}
					cameras_obj[position] = serialize_camera(cam);
				}
				obj[constants::PROJ_CAMERAS] = std::move(cameras_obj);

				return add_json_item(preset.key, std::move(obj));
			}
			catch (const std::exception& error) {
				log_error("save_preset(): " + std::string(error.what()));
				return false;
			}
		}

	protected:
		std::string class_tag() const override { return "UJsonProjectionConfiguration "; }

		const std::unordered_set<std::string>& allowed_fields() const override {
			static const std::unordered_set<std::string> fields = {
				constants::PROJ_NAME,
				constants::PROJ_CANVAS,
				constants::PROJ_CAMERAS
			};
			return fields;
		}

	private:
		static bool is_valid_position(const std::string& position) {
			for (const auto& k : constants::camera_position_keys()) {
				if (k == position) return true;
			}
			return false;
		}

		static cv::Size parse_size(const boost::json::object& obj) {
			cv::Size s{ 0, 0 };
			if (auto* w = obj.if_contains(constants::PROJ_WIDTH);  w && w->is_int64())  s.width = static_cast<int>(w->as_int64());
			if (auto* h = obj.if_contains(constants::PROJ_HEIGHT); h && h->is_int64())  s.height = static_cast<int>(h->as_int64());
			return s;
		}

		static cv::Rect parse_rect(const boost::json::object& obj) {
			cv::Rect r{ 0, 0, 0, 0 };
			if (auto* x = obj.if_contains(constants::PROJ_X);      x && x->is_int64()) r.x = static_cast<int>(x->as_int64());
			if (auto* y = obj.if_contains(constants::PROJ_Y);      y && y->is_int64()) r.y = static_cast<int>(y->as_int64());
			if (auto* w = obj.if_contains(constants::PROJ_WIDTH);  w && w->is_int64()) r.width = static_cast<int>(w->as_int64());
			if (auto* h = obj.if_contains(constants::PROJ_HEIGHT); h && h->is_int64()) r.height = static_cast<int>(h->as_int64());
			return r;
		}

		static std::vector<cv::Point2f> parse_points(const boost::json::value& v) {
			std::vector<cv::Point2f> pts;
			if (!v.is_array()) return pts;
			const auto& arr = v.as_array();
			pts.reserve(arr.size());
			for (const auto& p : arr) {
				if (!p.is_array() || p.as_array().size() < 2) continue;
				const auto& pa = p.as_array();
				if (!pa[0].is_number() || !pa[1].is_number()) continue;
				pts.emplace_back(
					static_cast<float>(pa[0].to_number<double>()),
					static_cast<float>(pa[1].to_number<double>())
				);
			}
			return pts;
		}

		std::optional<FProjectionCamera> parse_camera(const std::string& key, const boost::json::object& obj) const {
			FProjectionCamera cam;
			cam.key = key;

			if (auto* name = obj.if_contains(constants::PROJ_CAM_NAME); name && name->is_string()) {
				cam.name = name->as_string();
			}
			else { cam.name = constants::PROJ_CAM_UNDEFINED; }

			if (auto* sp = obj.if_contains(constants::PROJ_SRC_POINTS)) {
				cam.src_points = parse_points(*sp);
			}
			if (auto* dp = obj.if_contains(constants::PROJ_DST_POINTS)) {
				cam.dst_points = parse_points(*dp);
			}
			if (auto* cr = obj.if_contains(constants::PROJ_CANVAS_REGION)) {
				cam.canvas_region = parse_points(*cr);
			}

			if (cam.src_points.size() != cam.dst_points.size()) {
				log_warn("parse_camera(<" + key + ">): src_points and dst_points sizes mismatch ("
					+ std::to_string(cam.src_points.size()) + " vs "
					+ std::to_string(cam.dst_points.size()) + ")");
			}
			return cam;
		}

		// ===== Сериализация структур обратно в json =====

		static boost::json::object serialize_size(const cv::Size& s) {
			boost::json::object o;
			o[constants::PROJ_WIDTH] = s.width;
			o[constants::PROJ_HEIGHT] = s.height;
			return o;
		}

		static boost::json::object serialize_rect(const cv::Rect& r) {
			boost::json::object o;
			o[constants::PROJ_X] = r.x;
			o[constants::PROJ_Y] = r.y;
			o[constants::PROJ_WIDTH] = r.width;
			o[constants::PROJ_HEIGHT] = r.height;
			return o;
		}

		static boost::json::array serialize_points(const std::vector<cv::Point2f>& pts) {
			boost::json::array arr;
			arr.reserve(pts.size());
			for (const auto& p : pts) {
				boost::json::array tuple;
				tuple.emplace_back(p.x);
				tuple.emplace_back(p.y);
				arr.push_back(std::move(tuple));
			}
			return arr;
		}

		static boost::json::object serialize_camera(const FProjectionCamera& cam) {
			boost::json::object o;
			o[constants::PROJ_CAM_KEY] = cam.key;
			o[constants::PROJ_CAM_NAME] = cam.name;
			o[constants::PROJ_SRC_POINTS] = serialize_points(cam.src_points);
			o[constants::PROJ_DST_POINTS] = serialize_points(cam.dst_points);
			o[constants::PROJ_CANVAS_REGION] = serialize_points(cam.canvas_region);
			return o;
		}
	};

} // namespace calibration
} // namespace varan