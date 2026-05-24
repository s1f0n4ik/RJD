#pragma once

namespace varan {
namespace neural {
	
	struct FClassInfo {
		int          id;          // ключ класса (0, 1, 2 ...)
		std::string  name;        // отображаемое имя (RU)
		std::string  server_id;   // что уходит на сервер
		std::string  superclass;  // "person", "attachment", ...
		std::string  color;       // HEX, "#RRGGBB"
	};

	struct FThresholds {
		float nms = 0.45f;
		float confidence = 0.5f;
	};

	struct FConfigInfo {
		std::string id;
		std::string name;
		std::string camera_id = "camera_1";
		// int raw_width = 2560;
		// int raw_height = 1440;
		int model_width = 640;
		int model_height = 640;
		FThresholds thresholds;
		std::string model_path;
		std::vector<FClassInfo> classes;
	};

}
}