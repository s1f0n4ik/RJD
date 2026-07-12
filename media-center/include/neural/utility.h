#pragma once
#include <memory>
#include <optional>
#include <string>
#include <filesystem>

#include <opencv2/opencv.hpp>
#include <opencv2/freetype.hpp>

#include "tracker/tracking-types.h"
#include "neural/matrix.h"
#include "logger.h"

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

	// Структура для описания активного потока (дескриптора)
	struct FNeuralCoreConfig {
		std::string   config_id;
		FCameraLayout camera_layout;  // ← богатая раскладка камер (пока обрабатывается только single)
		std::vector<int> npu_cores;   // ← теперь здесь, не в конфиге

		// Доп настройки для дескриптора
		int fps = 10;  // Отвечает за фпс неронки, если включен и стрим, то и на него
		std::optional<FStreamingDesc> streaming; // если есть стриминг, то он хранит в себе id и name
		std::vector<std::string> event_mask;     // маска событий (пока просто прокидывается дальше)
	};

	// Рендер текста с поддержкой кириллицы через cv::freetype (opencv_contrib).
	// cv::putText кириллицу не рисует — только Hershey-шрифты (ASCII). Шрифт
	// берётся из fonts/ рядом с исполняемым файлом (CMake копирует эту папку
	// в билд-дерево так же, как shaders/) — не зависит от того, что стоит на
	// устройстве. Отдельный экземпляр UTextRenderer на каждый USlot.
	class UTextRenderer {
	public:
		explicit UTextRenderer(int font_height = 22, ULogger::ELoggerLevel level = ULogger::ELoggerLevel::INFO)
			: m_font_height(font_height)
			, m_logger("TextRenderer", level)
		{
			// PT Sans (OFL) — кириллица + латиница, лежит в fonts/ (см. media-center/fonts).
			static constexpr const char* FONT_CANDIDATES[] = {
				"fonts/PTSans-Regular.ttf",
				"fonts/PTSans-Bold.ttf",
			};

			for (const char* path : FONT_CANDIDATES) {
				if (!std::filesystem::exists(path)) continue;

				auto ft = cv::freetype::createFreeType2();
				try {
					ft->loadFontData(path, 0);
					m_ft = ft;
					m_logger.info("font loaded: " + std::string(path));
					break;
				}
				catch (const cv::Exception& e) {
					m_logger.warn("failed to load font " + std::string(path) + ": " + e.what());
				}
			}

			if (!m_ft) {
				m_logger.warn("fonts/PTSans-Regular.ttf not found next to the executable — "
					"overlay text (class names, time/GPS) will not be drawn. "
					"Check that CMake copied media-center/fonts into the build directory.");
			}
		}

		// false — на устройстве не нашлось шрифта с кириллицей; put_text()/text_size()
		// в этом случае no-op, вызывающий код должен пропускать отрисовку текста.
		bool available() const { return static_cast<bool>(m_ft); }

		// font_height < 0 — использовать высоту по умолчанию (передана в конструктор).
		// FreeType не привязывает размер к загрузке шрифта, так что один экземпляр
		// можно использовать для текста разного размера (метки детекций/оверлей).
		void put_text(cv::Mat& frame, const std::string& utf8_text, cv::Point origin, const cv::Scalar& color, int font_height = -1) {
			if (!m_ft || frame.empty()) return;
			m_ft->putText(frame, utf8_text, origin, font_height > 0 ? font_height : m_font_height, color, -1, cv::LINE_AA, false);
		}

		cv::Size text_size(const std::string& utf8_text, int* baseline = nullptr, int font_height = -1) const {
			if (!m_ft) {
				if (baseline) *baseline = 0;
				return {};
			}
			int bl = 0;
			cv::Size sz = m_ft->getTextSize(utf8_text, font_height > 0 ? font_height : m_font_height, -1, &bl);
			if (baseline) *baseline = bl;
			return sz;
		}

	private:
		cv::Ptr<cv::freetype::FreeType2> m_ft;
		int m_font_height;
		ULogger m_logger;
	};

}
}