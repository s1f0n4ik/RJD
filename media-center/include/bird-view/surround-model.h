#pragma once

#include <glm.hpp>

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace varan {
namespace birdview {

	// Непрерывный диапазон вершин одного материала в общем буфере
	struct FSurroundModelPrimitive {
		int first = 0;
		int count = 0;
		float base_color[4] = { 1.0f, 1.0f, 1.0f, 1.0f };
		// Индекс в textures, -1 - примитив без текстуры
		int texture = -1;
	};

	// Декодированная в RGBA8 текстура из бинарника модели
	struct FSurroundModelTexture {
		int width = 0;
		int height = 0;
		std::vector<uint8_t> rgba;
	};

	// Модель, запечённая к отрисовке: трансформы узлов применены к вершинам,
	// юниты исходные - вписывание в габарит делает рендерер по bbox
	struct FSurroundModel {
		// Интерлив на вершину: позиция 3, нормаль 3, uv 2
		std::vector<float> vertices;
		std::vector<FSurroundModelPrimitive> primitives;
		std::vector<FSurroundModelTexture> textures;
		glm::vec3 bbox_min{ 0.0f };
		glm::vec3 bbox_max{ 0.0f };
	};

	inline constexpr int SURROUND_MODEL_STRIDE = 8;

	// Читает .glb: треугольники, baseColorFactor и baseColorTexture.
	// Нет нормалей - считаются плоские по граням, нет uv - нули
	bool load_surround_model(
		const std::filesystem::path& path,
		FSurroundModel& out,
		std::string& error);

} // birdview
} // varan
