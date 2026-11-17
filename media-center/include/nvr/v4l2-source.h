#pragma once

#include <map>
#include <optional>
#include <stdexcept>
#include <string>

#include <boost/json.hpp>

#include "utility/data-structs.h"

namespace varan {
namespace nvr {

	// Пустая строка — камера описана верно
	inline std::string check_v4l2_source(const FV4l2Source& source) {
		if (source.device.empty()) return "v4l2 device is empty";
		if (source.format != "YUYV" && source.format != "UYVY" && source.format != "NV12" && source.format != "MJPG") {
			return "v4l2 format must be YUYV, UYVY, NV12 or MJPG";
		}
		if (source.width <= 0 || source.height <= 0 || source.width % 2 != 0 || source.height % 2 != 0) {
			return "v4l2 frame size must be positive and even";
		}
		if (source.fps < 1 || source.fps > 120) return "v4l2 fps is out of range 1...120";
		if (source.rotation != 0 && source.rotation != 90 && source.rotation != 180 && source.rotation != 270) {
			return "v4l2 rotation must be 0, 90, 180 or 270";
		}
		// YUYV и UYVY кодер не поворачивает: остаётся 180 сенсором CSI, CSI задаётся именем узла, а не путём
		const bool packed = source.format == "YUYV" || source.format == "UYVY";
		const bool csi = source.device.rfind("/dev/", 0) != 0;
		if (packed && source.rotation != 0 && !(csi && source.rotation == 180)) {
			return "v4l2 rotation of YUYV and UYVY is only 180 by a CSI sensor";
		}
		if (source.bitrate < 0) return "v4l2 bitrate can't be negative";
		if (source.gop < 1 || source.gop > 60) return "v4l2 gop is out of range 1...60 seconds";
		return {};
	}

	// Камера на плате отдаёт ровно один поток stream_1
	inline std::string check_v4l2_streams(const std::map<std::string, FPipelineConfig>& streams) {
		if (streams.size() != 1 || !streams.count("stream_1")) return "camera on board must have exactly one stream stream_1";
		return {};
	}

	inline boost::json::object v4l2_to_json(const FV4l2Source& source) {
		return {
			{"device", source.device},
			{"format", source.format},
			{"width", source.width},
			{"height", source.height},
			{"fps", source.fps},
			{"rotation", source.rotation},
			{"swap_uv", source.swap_uv},
			{"bitrate", source.bitrate},
			{"gop", source.gop}
		};
	}

	// Поля, которых нет в объекте, остаются по умолчанию; неверный тип бросает исключение
	inline FV4l2Source v4l2_from_json(const boost::json::object& obj) {
		FV4l2Source source;

		if (const auto* device = obj.if_contains("device")) source.device = boost::json::value_to<std::string>(*device);
		if (const auto* format = obj.if_contains("format")) source.format = boost::json::value_to<std::string>(*format);
		if (const auto* width = obj.if_contains("width")) source.width = boost::json::value_to<int>(*width);
		if (const auto* height = obj.if_contains("height")) source.height = boost::json::value_to<int>(*height);
		if (const auto* fps = obj.if_contains("fps")) source.fps = boost::json::value_to<int>(*fps);
		if (const auto* rotation = obj.if_contains("rotation")) source.rotation = boost::json::value_to<int>(*rotation);
		if (const auto* swap_uv = obj.if_contains("swap_uv")) source.swap_uv = boost::json::value_to<bool>(*swap_uv);
		if (const auto* bitrate = obj.if_contains("bitrate")) source.bitrate = boost::json::value_to<int>(*bitrate);
		if (const auto* gop = obj.if_contains("gop")) source.gop = boost::json::value_to<int>(*gop);

		return source;
	}

	// Источник из объекта камеры: rtsp или нет поля — пусто, v4l2 — проверенный блок; ошибка бросает исключение
	inline std::optional<FV4l2Source> camera_v4l2_from_json(const boost::json::object& camera) {
		const auto* kind = camera.if_contains("source");
		const std::string source = kind ? boost::json::value_to<std::string>(*kind) : "rtsp";
		if (source == "rtsp") return std::nullopt;
		if (source != "v4l2") throw std::runtime_error("camera source must be rtsp or v4l2");

		const auto* block = camera.if_contains("v4l2");
		if (!block || !block->is_object()) throw std::runtime_error("camera source v4l2 needs the v4l2 object");

		auto v4l2 = v4l2_from_json(block->as_object());
		if (const auto error = check_v4l2_source(v4l2); !error.empty()) throw std::runtime_error(error);
		return v4l2;
	}

	// Поля source и v4l2 в объекте камеры
	inline void camera_v4l2_to_json(const std::optional<FV4l2Source>& v4l2, boost::json::object& camera) {
		camera["source"] = v4l2 ? "v4l2" : "rtsp";
		if (v4l2) camera["v4l2"] = v4l2_to_json(*v4l2);
	}

} // nvr
} // varan
