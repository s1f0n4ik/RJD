#pragma once
#include <memory>
#include <optional>

#include "tracker/tracking-types.h"
#include "neural/matrix.h"

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

	struct FSuperclass {
		std::string key; 
		std::string name; 
		std::string color; 
	};

	struct FNeuralExports {
		std::string id;
		std::string name;
	};

	struct FStreamingDesc {
		std::string id;
		std::string name;
		std::string ip;
		std::string port;
	};

	// Структура для описания конфигураций детекций
	struct FConfigInfo {
		std::string id;
		std::string name;
		int model_width = 640;
		int model_height = 640;
		int fps = 25;
		bool enable_raw_stream = false;  // Флаг для включения прямого стриминга 
		std::string stream_id;  // Название стрима для подключения 
		FThresholds thresholds;
		std::string model_path;
		std::shared_ptr<FTrackerConfig> tracker_config;
		std::vector<FClassInfo> classes;
		std::vector<FSuperclass> superclasses;   // группы для отрисовки
	};

	// Структура для описания активного ядра
	struct FNeuralCoreConfig {
		std::string   config_id;
		FCameraMatrix cameras;
		std::vector<int> npu_cores;   // ← теперь здесь, не в конфиге

		// Доп настройки для дескриптора
		int fps = 10;  // Отвечает за фпс неронки, если включен и стрим, то и на него
		std::optional<FStreamingDesc> streaming; // есть есть стриминг, то он хранит в себе id и name
	};

}
}