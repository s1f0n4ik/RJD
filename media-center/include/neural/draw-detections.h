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

	// ── Детальная отрисовка (на RGB-кадре) ──
	inline void draw_detections(
		cv::Mat& frame_rgb,
		const std::vector<FDetection>& detections,
		const std::vector<uint8_t>& mask,
		const std::vector<FClassInfo>& classes,
		float alpha = 0.4f)
	{
		if (frame_rgb.empty()) return;

		if (!mask.empty() &&
			static_cast<int>(mask.size()) == frame_rgb.rows * frame_rgb.cols)
		{
			cv::Mat overlay = frame_rgb.clone();
			for (int y = 0; y < frame_rgb.rows; ++y) {
				const uint8_t* mrow = mask.data() + y * frame_rgb.cols;
				cv::Vec3b* prow = overlay.ptr<cv::Vec3b>(y);
				for (int x = 0; x < frame_rgb.cols; ++x) {
					if (mrow[x] == 0) continue;
					const int cls_id = mrow[x] - 1;
					if (cls_id < 0 || cls_id >= (int)classes.size()) continue;
					cv::Scalar col = hex_to_rgb(classes[cls_id].color);
					prow[x] = cv::Vec3b(
						static_cast<uchar>(col[0]),
						static_cast<uchar>(col[1]),
						static_cast<uchar>(col[2]));
				}
			}
			cv::addWeighted(overlay, alpha, frame_rgb, 1.0f - alpha, 0.0, frame_rgb);
		}

		for (const auto& d : detections) {
			const int cls_id = d.class_id;
			cv::Scalar color = (cls_id >= 0 && cls_id < (int)classes.size())
				? hex_to_rgb(classes[cls_id].color)
				: cv::Scalar(255, 255, 0);
			const std::string name = (cls_id >= 0 && cls_id < (int)classes.size())
				? classes[cls_id].name
				: "unknown";

			cv::Rect r(d.x1_coord, d.y1_coord,
				d.x2_coord - d.x1_coord, d.y2_coord - d.y1_coord);
			cv::rectangle(frame_rgb, r, color, 2);

			char buf[64];
			std::snprintf(buf, sizeof(buf), "%s %.2f", name.c_str(), d.confidence);
			const std::string label(buf);

			int baseline = 0;
			cv::Size ts = cv::getTextSize(label, cv::FONT_HERSHEY_SIMPLEX, 0.5, 1, &baseline);
			const int ty1 = std::max(0, d.y1_coord - ts.height - 4);
			cv::rectangle(frame_rgb,
				cv::Rect(d.x1_coord, ty1, ts.width + 6, ts.height + 4),
				color, cv::FILLED);
			cv::putText(frame_rgb, label,
				cv::Point(d.x1_coord + 3, ty1 + ts.height),
				cv::FONT_HERSHEY_SIMPLEX, 0.5,
				cv::Scalar(0, 0, 0), 1, cv::LINE_AA);
		}
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

	inline void draw_detections_grouped(
		cv::Mat& frame_rgb,
		const std::vector<FDetection>& detections,
		const std::vector<uint8_t>& mask,
		const std::vector<FClassInfo>& classes,
		float alpha = 0.4f)
	{
		if (frame_rgb.empty()) return;

		if (!mask.empty() &&
			static_cast<int>(mask.size()) == frame_rgb.rows * frame_rgb.cols)
		{
			cv::Mat overlay = frame_rgb.clone();
			for (int y = 0; y < frame_rgb.rows; ++y) {
				const uint8_t* mrow = mask.data() + y * frame_rgb.cols;
				cv::Vec3b* prow = overlay.ptr<cv::Vec3b>(y);
				for (int x = 0; x < frame_rgb.cols; ++x) {
					if (mrow[x] == 0) continue;
					const int cls_id = mrow[x] - 1;
					if (cls_id < 0 || cls_id >= (int)classes.size()) continue;
					EGroupKind g = classify_group(classes[cls_id].superclass);
					cv::Scalar col = group_color(g);
					prow[x] = cv::Vec3b(
						static_cast<uchar>(col[0]),
						static_cast<uchar>(col[1]),
						static_cast<uchar>(col[2]));
				}
			}
			cv::addWeighted(overlay, alpha, frame_rgb, 1.0f - alpha, 0.0, frame_rgb);
		}

		for (const auto& d : detections) {
			const int cls_id = d.class_id;
			if (cls_id < 0 || cls_id >= (int)classes.size()) continue;

			EGroupKind g = classify_group(classes[cls_id].superclass);
			cv::Scalar color = group_color(g);
			const char* label_ascii = group_label_ascii(g);

			cv::Rect r(d.x1_coord, d.y1_coord,
				d.x2_coord - d.x1_coord, d.y2_coord - d.y1_coord);
			cv::rectangle(frame_rgb, r, color, 2);

			char buf[64];
			std::snprintf(buf, sizeof(buf), "%s %.2f", label_ascii, d.confidence);
			const std::string label(buf);

			int baseline = 0;
			cv::Size ts = cv::getTextSize(label, cv::FONT_HERSHEY_SIMPLEX, 1.2, 2, &baseline);
			const int ty1 = std::max(0, d.y1_coord - ts.height - 4);
			cv::rectangle(frame_rgb,
				cv::Rect(d.x1_coord, ty1, ts.width + 6, ts.height + 4),
				color, cv::FILLED);
			cv::putText(frame_rgb, label,
				cv::Point(d.x1_coord + 3, ty1 + ts.height),
				cv::FONT_HERSHEY_SIMPLEX, 1.0,
				cv::Scalar(255, 255, 255), 1, cv::LINE_AA);
		}
	}

} // namespace neural
} // namespace varan