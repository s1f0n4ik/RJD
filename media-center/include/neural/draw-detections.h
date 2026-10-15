#pragma once

#include <opencv2/opencv.hpp>
#include <vector>
#include <string>

#include "neural/yolov8.h"
#include "neural/utility.h"

namespace varan {
namespace neural {

	// HEX "#RRGGBB" → cv::Scalar(R, G, B) — для RGB-кадра.
	inline cv::Scalar hex_to_rgb(const std::string& hex) {
		if (hex.size() < 7 || hex[0] != '#') return cv::Scalar(255, 255, 0);
		auto h = [&](int i) -> int {
			char c = hex[i];
			if (c >= '0' && c <= '9') return c - '0';
			if (c >= 'a' && c <= 'f') return c - 'a' + 10;
			if (c >= 'A' && c <= 'F') return c - 'A' + 10;
			return 0;
			};
		const int r = (h(1) << 4) | h(2);
		const int g = (h(3) << 4) | h(4);
		const int b = (h(5) << 4) | h(6);
		return cv::Scalar(r, g, b);
	}

	// ── Групповая отрисовка (на RGB-кадре) ──
	//
	// Цвета в RGB:
	//   оранжевый = (255, 140, 0)
	//   красный   = (220, 0, 0)
	//
	// Кириллица в cv::putText без freetype не работает. Используются ASCII-метки.

	enum class EGroupKind {
		HUMAN = 0,
		ANIMAL = 1,
		OTHER = 2,
	};

	inline EGroupKind classify_group(const std::string& superclass) {
		if (superclass == "human")  return EGroupKind::HUMAN;
		if (superclass == "animal") return EGroupKind::ANIMAL;
		return EGroupKind::OTHER;
	}

	inline cv::Scalar group_color(EGroupKind g) {
		switch (g) {
		case EGroupKind::HUMAN:
		case EGroupKind::ANIMAL: return cv::Scalar(0, 220, 0);  // RGB зеленый
		case EGroupKind::OTHER:
		default:                 return cv::Scalar(220, 0, 0);  // RGB красный
		}
	}

	inline const char* group_label_ascii(EGroupKind g) {
		switch (g) {
		case EGroupKind::HUMAN:  return "Person";
		case EGroupKind::ANIMAL: return "Animal";
		case EGroupKind::OTHER:
		default:                 return "Dangerous object";
		}
	}

	// Вид рамки: сплошная с подписью, пунктир без подписи, пунктир с подписью
	enum class EBoxStyle { SOLID, DASHED, DASHED_LABELED };

	// Пунктирная замкнутая ломаная: штрих и промежуток по dash пикселей
	inline void dashed_polyline(cv::Mat& img, const std::vector<cv::Point>& points, const cv::Scalar& color, int thickness = 2, int dash = 6) {
		for (size_t i = 0; i < points.size(); ++i) {
			const cv::Point a = points[i];
			const cv::Point b = points[(i + 1) % points.size()];
			const double len = cv::norm(b - a);
			if (len <= 0) continue;
			for (double s = 0; s < len; s += 2 * dash)
				cv::line(img, a + (b - a) * (s / len), a + (b - a) * (std::min(len, s + dash) / len), color, thickness);
		}
	}

	inline void dashed_rectangle(cv::Mat& img, const cv::Rect& r, const cv::Scalar& color, int thickness = 2, int dash = 6) {
		dashed_polyline(img, { r.tl(), { r.x + r.width, r.y }, r.br(), { r.x, r.y + r.height } }, color, thickness, dash);
	}

	// Полупрозрачная заливка контуров: копия и смешивание только в прямоугольнике вокруг них
	inline void fill_polygons(cv::Mat& img, const std::vector<std::vector<cv::Point>>& polygons, cv::Scalar color, double alpha) {
		cv::Rect roi;
		for (const auto& polygon : polygons) roi |= cv::boundingRect(polygon);
		roi &= cv::Rect(0, 0, img.cols, img.rows);
		if (roi.empty()) return;

		color[3] = 255;
		cv::Mat area = img(roi);
		cv::Mat layer = area.clone();
		cv::fillPoly(layer, polygons, color, cv::LINE_8, 0, -roi.tl());
		cv::addWeighted(layer, alpha, area, 1.0 - alpha, 0.0, area);
	}

	// styles идёт параллельно detections; пустой — все рамки сплошные
	// Детекция с контурами рисуется контуром с заливкой fill_alpha вместо рамки
	inline void draw_detections_grouped(
		cv::Mat& frame_rgb,
		const std::vector<FDetection>& detections,
		const std::vector<FClassInfo>& classes,
		const std::vector<FSuperclass>& superclasses,
		const std::vector<EBoxStyle>& styles = {},
		double fill_alpha = 0.28)
	{
		if (frame_rgb.empty()) return;

		// superclass key → color
		std::unordered_map<std::string, cv::Scalar> sc_colors;
		for (const auto& sc : superclasses)
			sc_colors[sc.key] = hex_to_rgb(sc.color);
		const cv::Scalar fallback(220, 0, 0);

		auto color_of = [&](const std::string& sc_key) -> cv::Scalar {
			auto it = sc_colors.find(sc_key);
			return (it != sc_colors.end()) ? it->second : fallback;
			};

		// Контур с заливкой или bbox + подпись "id conf"
		for (size_t i = 0; i < detections.size(); ++i) {
			const auto& d = detections[i];
			if (d.class_id < 0 || d.class_id >= (int)classes.size()) continue;

			cv::Scalar color = color_of(classes[d.class_id].superclass);
			const EBoxStyle style = i < styles.size() ? styles[i] : EBoxStyle::SOLID;

			if (!d.polygons.empty()) {
				fill_polygons(frame_rgb, d.polygons, color, fill_alpha);
				if (style == EBoxStyle::SOLID) cv::polylines(frame_rgb, d.polygons, true, color, 2);
				else for (const auto& polygon : d.polygons) dashed_polyline(frame_rgb, polygon, color);
			}
			else {
				cv::Rect r(d.x1_coord, d.y1_coord,
					d.x2_coord - d.x1_coord, d.y2_coord - d.y1_coord);
				if (style == EBoxStyle::SOLID) cv::rectangle(frame_rgb, r, color, 2);
				else dashed_rectangle(frame_rgb, r, color);
			}
			if (style == EBoxStyle::DASHED) continue;

			char buf[32];
			std::snprintf(buf, sizeof(buf), "%d %.2f", d.class_id, d.confidence);

			int baseline = 0;
			cv::Size ts = cv::getTextSize(buf, cv::FONT_HERSHEY_SIMPLEX, 0.5, 1, &baseline);
			int ty = std::max(0, d.y1_coord - ts.height - 4);

			cv::rectangle(frame_rgb,
				cv::Rect(d.x1_coord, ty, ts.width + 6, ts.height + 4),
				color, cv::FILLED);
			cv::putText(frame_rgb, buf,
				cv::Point(d.x1_coord + 3, ty + ts.height),
				cv::FONT_HERSHEY_SIMPLEX, 0.5,
				cv::Scalar(255, 255, 255), 1, cv::LINE_AA);
		}
	}

} // namespace neural
} // namespace varan