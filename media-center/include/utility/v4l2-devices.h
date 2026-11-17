#pragma once

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

#include <boost/json.hpp>

#include "utility/data-structs.h"

namespace varan {
namespace nvr {

	// Размер кадра и частоты, которые драйвер называет для него; пусто — драйвер частот не называет
	struct FV4l2Size {
		int width = 0;
		int height = 0;
		std::vector<int> fps;
	};

	// Формат камеры: перечисленные размеры или диапазон с шагом, если кадр масштабирует ISP
	struct FV4l2Format {
		std::string format;
		std::vector<FV4l2Size> sizes;
		bool stepwise = false;
		int min_width = 0;
		int max_width = 0;
		int step_width = 0;
		int min_height = 0;
		int max_height = 0;
		int step_height = 0;
	};

	// Камера платы, которую MC умеет снимать
	struct FV4l2Camera {
		// Адрес для настроек: путь by-path у USB, имя узла у CSI
		std::string device;
		// Узел /dev/videoN, которым камера видна сейчас
		std::string node;
		std::string name;
		bool csi = false;
		// Модель сенсора CSI, например IMX219; пусто у USB
		std::string sensor;
		std::vector<FV4l2Format> formats;
	};

	// USB-камеры uvcvideo и узел ISP, если к плате подключён сенсор CSI
	std::vector<FV4l2Camera> list_v4l2_cameras();

	// Камера по адресу из настроек; пусто — на плате её нет
	std::optional<FV4l2Camera> find_v4l2_camera(const std::string& device);

	// 180 градусов отражением сенсора CSI и зеркальным кодом мозаики на входе ISP; false — не вышло, флаги сняты
	bool apply_sensor_rotation(bool want_180, std::string& message);

	// Пустая строка — камера умеет этот формат, размер и частоту
	inline std::string check_v4l2_mode(const FV4l2Camera& camera, const FV4l2Source& source) {
		const std::string frame = std::to_string(source.width) + "x" + std::to_string(source.height);

		for (const auto& format : camera.formats) {
			if (format.format != source.format) continue;

			if (format.stepwise) {
				const auto fits = [](int value, int low, int high, int step) {
					return value >= low && value <= high && (step <= 1 || (value - low) % step == 0);
				};
				const bool ok = fits(source.width, format.min_width, format.max_width, format.step_width)
					&& fits(source.height, format.min_height, format.max_height, format.step_height);
				return ok ? "" : "camera can't capture " + frame + " in " + source.format;
			}

			for (const auto& size : format.sizes) {
				if (size.width != source.width || size.height != source.height) continue;
				if (size.fps.empty() || std::find(size.fps.begin(), size.fps.end(), source.fps) != size.fps.end()) return {};
				return "camera can't capture " + frame + " " + source.format + " at " + std::to_string(source.fps) + " fps";
			}
			return "camera can't capture " + frame + " in " + source.format;
		}

		return "camera has no format " + source.format;
	}

	inline boost::json::object v4l2_camera_to_json(const FV4l2Camera& camera) {
		boost::json::array formats;
		for (const auto& format : camera.formats) {
			boost::json::object item{ {"format", format.format} };

			if (format.stepwise) {
				item["range"] = boost::json::object{
					{"min_width", format.min_width}, {"max_width", format.max_width}, {"step_width", format.step_width},
					{"min_height", format.min_height}, {"max_height", format.max_height}, {"step_height", format.step_height}
				};
			}
			else {
				boost::json::array sizes;
				for (const auto& size : format.sizes) {
					sizes.push_back(boost::json::object{
						{"width", size.width},
						{"height", size.height},
						{"fps", boost::json::array(size.fps.begin(), size.fps.end())}
					});
				}
				item["sizes"] = std::move(sizes);
			}

			formats.push_back(std::move(item));
		}

		return {
			{"device", camera.device},
			{"node", camera.node},
			{"name", camera.name},
			{"kind", camera.csi ? "csi" : "usb"},
			{"sensor", camera.sensor},
			{"formats", std::move(formats)}
		};
	}

} // nvr
} // varan
