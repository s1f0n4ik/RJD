#pragma once
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <filesystem>

#include <boost/json.hpp>
#include <opencv2/opencv.hpp>

#include "tracker/tracking-types.h"
#include "logger.h"

namespace varan {
namespace neural {

	// Ошибка загрузки модели или старта слота с кодом 6xxx из signaling_definers.h
	struct FNeuralError : std::runtime_error {
		int code;
		FNeuralError(int code, const std::string& message) : std::runtime_error(message), code(code) {}
	};

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
		// Модель с масками: детекция без контура отбрасывается
		bool require_mask = true;
	};

	struct FSuperclass {
		std::string key;
		std::string name;
		std::string color;
	};

	// Зона каталога конфигурации; приоритет — место в списке, первая выше всех
	struct FZoneInfo {
		// С 1; 0 — вне зон
		int id = 0;
		std::string name;
		std::string color;
		// Доля площади детекции в зоне 0..1; 0 — достаточно одного пикселя
		float threshold = 0.f;
	};

	struct FNeuralExports {
		std::string id;
		std::string name;
		// Описание модели из записи конфигурации; null — модель не прочитана
		boost::json::value model;
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
		int fps = 25;
		bool enable_raw_stream = false;  // Флаг для включения прямого стриминга 
		std::string stream_id;  // Название стрима для подключения 
		FThresholds thresholds;
		std::string model_path;
		std::shared_ptr<FTrackerConfig> tracker_config;
		std::vector<FClassInfo> classes;
		std::vector<FSuperclass> superclasses;   // группы для отрисовки
		std::vector<FZoneInfo> zones;
		// Трек переходит в зону выше, когда она держится столько кадров подряд
		int zone_enter_frames = 2;
		// Трек уходит в зону ниже, когда зоны выше нет столько секунд
		float zone_leave_s = 1.f;
	};

	// Дескриптор слота: видеопоток задаёт и камеры, и конфигурацию
	struct FNeuralCoreConfig {
		std::string   stream_id;
		// Конфигурация слота; пара (stream_id, config_id) уникальна
		std::string   config_id;
		// Кадров слота в полёте одновременно = контекстов NPU на слот
		int depth = 1;

		// Доп настройки для дескриптора
		int fps = 10;  // Отвечает за фпс неронки, если включен и стрим, то и на него
		std::optional<FStreamingDesc> streaming; // если есть стриминг, то он хранит в себе id и name
		// События трека, на которые берётся снимок кадра камеры
		std::vector<std::string> image_mask{ "confirmed" };
	};

	// Пункт маски снимка: устойчивая зона трека поднялась по приоритету
	inline const std::string IMAGE_ZONE_UP = "zone_up";

	// Строки JSON-массива; прочие элементы пропускаются
	inline std::vector<std::string> json_strings(const boost::json::array& arr) {
		std::vector<std::string> out;
		for (const auto& v : arr)
			if (v.is_string()) out.emplace_back(v.as_string().c_str());
		return out;
	}

	// Маска снимка слота; нет ключа — остаётся умолчание
	inline void read_event_masks(const boost::json::object& obj, FNeuralCoreConfig& desc) {
		if (auto* v = obj.if_contains("image_mask"); v && v->is_array())
			desc.image_mask = json_strings(v->as_array());
	}

	inline void write_event_masks(boost::json::object& obj, const FNeuralCoreConfig& desc) {
		obj["image_mask"] = boost::json::value_from(desc.image_mask);
	}

}
}