#pragma once

#include "utility/json-reader.h"
#include "constants.h"

using namespace varan::calibration::constants;

namespace varan {
namespace calibration {

	/*
		Конфигурация калибровки. Формат файла:

		{
			"<id>_<width>_<height>": {
				"id": "camera_01",
				"width": 1920,
				"height": 1080,

				"pattern_size": 25.0,
				"pattern_width": 9,
				"pattern_height": 6,
				"camera_matrix":   {...},
				"dist_coeffs":     {...},
				"rms": 1.0,

				"new_K":            {...},
				"undist_map_x":     "path/to/file",
				"undist_map_y":     "path/to/file",

				"warp_map_x":       "path/to/file",
				"warp_map_y":       "path/to/file"
			}
		}
	*/
	class UJsonCalibrationConfiguration : public UJsonReaderBase {
	public:
		explicit UJsonCalibrationConfiguration(ULogger* logger = nullptr)
			: UJsonReaderBase(logger) {}

		// ===== view-методы, специфичные для схемы калибровки =====

		boost::json::array get_cameras_info() const {
			boost::json::array result;
			try {
				for (const auto& [key, value] : m_json) {
					if (!value.is_object()) continue;

					const auto& obj = value.as_object();
					if (!contains_required_fields(obj)) continue;

					boost::json::object item;
					item[JSON_CONFIG_KEY] = key;
					item[JSON_ID] = obj.at(JSON_ID);
					item[JSON_WIDTH] = obj.at(JSON_WIDTH);
					item[JSON_HEIGHT] = obj.at(JSON_HEIGHT);
					result.push_back(item);
				}
			}
			catch (const std::exception& error) {
				log_error("get_cameras_info(): " + std::string(error.what()));
			}
			return result;
		}

		boost::json::object get_sender_json_item(const std::string& key) const {
			boost::json::object result;
			try {
				auto it = m_json.find(key);
				if (it == m_json.end()) {
					log_debug("get_sender_json_item(): no such key=" + key);
					return result;
				}
				if (!it->value().is_object()) {
					log_debug("get_sender_json_item(): value at key=" + key + " is not an object");
					return result;
				}

				const auto& obj = it->value().as_object();
				if (!contains_required_fields(obj)) {
					return result;
				}

				result[JSON_ID] = obj.at(JSON_ID);
				result[JSON_WIDTH] = obj.at(JSON_WIDTH);
				result[JSON_HEIGHT] = obj.at(JSON_HEIGHT);

				bool has_pattern = contains_pattern_fields(obj);
				result[JSON_IS_PATTERN] = has_pattern;
				if (has_pattern) {
					result[JSON_PATTERN_SIZE] = obj.at(JSON_PATTERN_SIZE);
					result[JSON_PATTERN_WIDTH] = obj.at(JSON_PATTERN_WIDTH);
					result[JSON_PATTERN_HEIGHT] = obj.at(JSON_PATTERN_HEIGHT);
				}

				bool has_calibrated = contains_calibration_fields(obj);
				result[JSON_IS_CALIBRATION] = has_calibrated;
				if (has_calibrated) {
					result[JSON_RMS] = obj.at(JSON_RMS);
					result[META_ALPHA] = obj.at(META_ALPHA);
					result[META_ZOOM] = obj.at(META_ZOOM);
					result[META_SHIFT_X] = obj.at(META_SHIFT_X);
					result[META_SHIFT_Y] = obj.at(META_SHIFT_Y);
					result[META_DISTORION_COEFFS] = obj.at(META_DISTORION_COEFFS);
				}

				result[JSON_IS_UNDISTORTION] = contains_undistortion_fields(obj);
				return result;
			}
			catch (const std::exception& error) {
				log_error("get_sender_json_item(): " + std::string(error.what()));
				return {};
			}
		}

		// ===== предикаты на наличие наборов полей =====

		static bool contains_required_fields(const boost::json::object& obj) {
			return obj.contains(JSON_ID)
				&& obj.contains(JSON_WIDTH)
				&& obj.contains(JSON_HEIGHT);
		}

		static bool contains_pattern_fields(const boost::json::object& obj) {
			return obj.contains(JSON_PATTERN_SIZE)
				&& obj.contains(JSON_PATTERN_WIDTH)
				&& obj.contains(JSON_PATTERN_HEIGHT);
		}

		static bool contains_calibration_fields(const boost::json::object& obj) {
			return obj.contains(JSON_RMS)
				&& obj.contains(META_ALPHA)
				&& obj.contains(META_ZOOM)
				&& obj.contains(META_SHIFT_X)
				&& obj.contains(META_SHIFT_Y)
				&& obj.contains(JSON_CAMERA_MATRIX)
				&& obj.contains(JSON_DISTORTION_COEFFS);
		}

		static bool contains_undistortion_fields(const boost::json::object& obj) {
			return obj.contains(JSON_NEW_K)
				&& obj.contains(JSON_UNDISTORTION_MAP_X)
				&& obj.contains(JSON_UNDISTORTION_MAP_Y);
		}

		static std::string make_item_key(const std::string& id, int width, int height) {
			return (std::ostringstream() << id << "_" << width << "_" << height).str();
		}

	protected:
		std::string class_tag() const override { return "UJsonCalibrationConfiguration "; }

		const std::unordered_set<std::string>& allowed_fields() const override {
			static const std::unordered_set<std::string> fields = {
				JSON_ID, JSON_WIDTH, JSON_HEIGHT,
				JSON_PATTERN_SIZE, JSON_PATTERN_WIDTH, JSON_PATTERN_HEIGHT,
				JSON_RMS, JSON_ALPHA, JSON_ZOOM, JSON_SHIFT_X, JSON_SHIFT_Y,
				JSON_CAMERA_MATRIX, JSON_DISTORTION_COEFFS,
				JSON_NEW_K, JSON_UNDISTORTION_MAP_X, JSON_UNDISTORTION_MAP_Y,
				JSON_WARP_MAP_X, JSON_WARP_MAP_Y
			};
			return fields;
		}
	};

} // namespace calibration
} // namespace varan