#pragma once

#include <algorithm>
#include <chrono>
#include <climits>
#include <cmath>
#include <vector>

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>

#include "neural/detection.h"
#include "neural/utility.h"
#include "neural/video-stream.h"

namespace varan {
namespace neural {

	// Место зоны в каталоге с 1; 0 и неизвестная зона — ниже всех
	inline int zone_rank(const std::vector<FZoneInfo>& catalog, int zone) {
		for (size_t i = 0; i < catalog.size(); ++i)
			if (catalog[i].id == zone) return static_cast<int>(i) + 1;
		return INT_MAX;
	}

	// Растр зон одной камеры: маска каждой зоны в уменьшенном кадре и её интегральное изображение
	class UZoneMap {
	public:
		// Длинная сторона растра в клетках
		static constexpr int kRasterSide = 640;

		UZoneMap() = default;

		// polygons — многоугольники этой камеры в долях кадра; frame — размер кадра камеры в пикселях
		UZoneMap(const std::vector<FZoneInfo>& catalog, const std::vector<FZonePolygon>& polygons, cv::Size frame)
			: m_frame(frame)
		{
			if (frame.width <= 0 || frame.height <= 0) return;
			m_scale = std::min(1.0, static_cast<double>(kRasterSide) / std::max(frame.width, frame.height));
			m_raster = cv::Size(std::max(1, static_cast<int>(std::lround(frame.width * m_scale))),
				std::max(1, static_cast<int>(std::lround(frame.height * m_scale))));
			for (const auto& z : catalog) {
				std::vector<std::vector<cv::Point>> shapes;
				for (const auto& p : polygons) {
					if (p.zone != z.id || p.points.size() < 3) continue;
					std::vector<cv::Point> shape;
					shape.reserve(p.points.size());
					for (const auto& pt : p.points)
						shape.emplace_back(static_cast<int>(std::lround(pt.x * m_raster.width)), static_cast<int>(std::lround(pt.y * m_raster.height)));
					shapes.push_back(std::move(shape));
				}
				if (shapes.empty()) continue;
				FLayer layer{ z.id, z.threshold, cv::Mat::zeros(m_raster, CV_8U), {} };
				cv::fillPoly(layer.mask, shapes, cv::Scalar(1));
				cv::integral(layer.mask, layer.integral, CV_32S);
				m_layers.push_back(std::move(layer));
			}
		}

		bool empty() const { return m_layers.empty(); }
		const cv::Size& frame() const { return m_frame; }

		// Зона детекции в пикселях кадра камеры: первая по каталогу, прошедшая свой порог; 0 — вне зон
		int zone_of(const FDetection& d) const {
			if (m_layers.empty()) return 0;
			const int x1 = static_cast<int>(std::floor(d.x1_coord * m_scale));
			const int y1 = static_cast<int>(std::floor(d.y1_coord * m_scale));
			const int x2 = std::max(x1 + 1, static_cast<int>(std::ceil(d.x2_coord * m_scale)));
			const int y2 = std::max(y1 + 1, static_cast<int>(std::ceil(d.y2_coord * m_scale)));
			const cv::Rect box = cv::Rect(cv::Point(x1, y1), cv::Point(x2, y2)) & cv::Rect(0, 0, m_raster.width, m_raster.height);
			if (box.empty()) return 0;

			// Маска детекции в клетках рамки; пустая — считается по рамке
			cv::Mat shape;
			if (!d.polygons.empty()) {
				std::vector<std::vector<cv::Point>> local;
				local.reserve(d.polygons.size());
				for (const auto& polygon : d.polygons) {
					std::vector<cv::Point> pts;
					pts.reserve(polygon.size());
					for (const auto& p : polygon)
						pts.emplace_back(static_cast<int>(std::lround(p.x * m_scale)) - box.x, static_cast<int>(std::lround(p.y * m_scale)) - box.y);
					local.push_back(std::move(pts));
				}
				shape = cv::Mat::zeros(box.size(), CV_8U);
				cv::fillPoly(shape, local, cv::Scalar(1));
				if (cv::countNonZero(shape) == 0) shape.release();
			}
			const double area = shape.empty() ? static_cast<double>(box.area()) : static_cast<double>(cv::countNonZero(shape));

			for (const auto& l : m_layers) {
				double inside = 0;
				if (shape.empty()) {
					const auto& s = l.integral;
					inside = s.at<int>(box.y + box.height, box.x + box.width) - s.at<int>(box.y, box.x + box.width)
						- s.at<int>(box.y + box.height, box.x) + s.at<int>(box.y, box.x);
				}
				else {
					cv::Mat both;
					cv::bitwise_and(shape, l.mask(box), both);
					inside = cv::countNonZero(both);
				}
				if (l.threshold <= 0.f ? inside > 0 : inside >= l.threshold * area) return l.id;
			}
			return 0;
		}

	private:
		struct FLayer {
			int id;
			float threshold;
			cv::Mat mask;
			cv::Mat integral;
		};
		// В порядке каталога: первая выше всех
		std::vector<FLayer> m_layers;
		cv::Size m_frame;
		cv::Size m_raster;
		double m_scale = 1.0;
	};

	// Устойчивая зона трека
	struct FZoneTrack {
		int zone = 0;
		// Самая низкая из зон выше текущей в непрерывной серии кадров
		int run_zone = 0;
		int run_frames = 0;
		// Последний кадр, где трек был в зоне не ниже текущей
		std::chrono::steady_clock::time_point held;
	};

	enum class EZoneStep { SAME, UP, DOWN };

	// Шаг устойчивой зоны по сырой зоне измеренного кадра: вверх — enter_frames кадров подряд, вниз — leave_s секунд без зоны не ниже текущей
	inline EZoneStep step_zone(FZoneTrack& s, int raw, std::chrono::steady_clock::time_point at,
		const std::vector<FZoneInfo>& catalog, int enter_frames, float leave_s)
	{
		const int current = zone_rank(catalog, s.zone);
		const int rank = zone_rank(catalog, raw);
		if (rank < current) {
			s.held = at;
			if (s.run_frames == 0 || rank > zone_rank(catalog, s.run_zone)) s.run_zone = raw;
			if (++s.run_frames < enter_frames) return EZoneStep::SAME;
			s.zone = s.run_zone;
			s.run_frames = 0;
			return EZoneStep::UP;
		}
		s.run_frames = 0;
		if (rank == current) {
			s.held = at;
			return EZoneStep::SAME;
		}
		if (std::chrono::duration<float>(at - s.held).count() < leave_s) return EZoneStep::SAME;
		s.zone = raw;
		s.held = at;
		return EZoneStep::DOWN;
	}

} // namespace neural
} // namespace varan
