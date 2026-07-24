#pragma once

#include <opencv2/opencv.hpp>
#include <boost/json.hpp>
#include <glm.hpp>

#include <filesystem>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "logger.h"

namespace varan {
namespace birdview {

	// Габарит машины: метры и её прямоугольник на канвасе
	// Отступы чаши от борта в долях от min(length, width), с оверрайдом из JSON
	struct FSurroundMachine {
		float length = 0.0f;
		float width = 0.0f;
		float height = 0.0f;
		cv::Rect2f canvas_rect;

		float bowl_floor = 0.9f;
		float bowl_outer = 2.3f;
		float bowl_wall = 0.9f;
		float bowl_plate = 1.5f;
		// Ширина перехода на границе зон Вороного, доля от min(length, width)
		float bowl_blend = 0.3f;
	};

	struct FSurroundBakedCamera {
		std::string place_key;
		std::string camera_id;
		// Ошибка репроекции точек разметки в пикселях, показатель качества позы
		double reprojection_error = 0.0;
		// Вычисленная высота камеры над землёй, сверяется с реальной глазами
		double camera_height = 0.0;
	};

	// На вершину чаши 3 float на камеру: u, v, вес. Камер сколько угодно,
	// рендер идёт по проходу на камеру в накопительный буфер
	inline constexpr int SURROUND_ATTR_STRIDE = 3;

	struct FSurroundBake {
		FSurroundMachine machine;
		std::vector<FSurroundBakedCamera> cameras;
		std::vector<std::vector<float>> camera_attributes;
	};

	// Печёт пер-вершинные UV чаши при старте вывода: solvePnP по точкам
	// разметки сборки, проекция вершин в сырой кадр через fisheye-модель
	class USurroundBaker {
	public:
		explicit USurroundBaker(ULogger* logger = nullptr) : m_logger(logger) {}

		// Габарит нужен раньше печки: чаша масштабируется под него до проекции
		static bool parse_machine(
			const boost::json::object& surround_cfg,
			FSurroundMachine& out,
			std::string& error);

		bool bake(
			const boost::json::object& surround_cfg,
			const std::filesystem::path& presets_path,
			const std::filesystem::path& calibration_path,
			const std::unordered_map<std::string, std::optional<std::string>>& bindings,
			const std::vector<glm::vec3>& vertices,
			FSurroundBake& out,
			std::string& error);

	private:
		ULogger* m_logger;
	};

} // birdview
} // varan
