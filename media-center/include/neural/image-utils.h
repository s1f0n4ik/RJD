#pragma once

#include <cstdint>
#include <algorithm>
#include <opencv2/opencv.hpp>

namespace varan {
	namespace neural {

		struct letterbox_t {
			float scale = 1.0f;
			int   x_pad = 0;
			int   y_pad = 0;
		};

		struct image_buffer_t {
			int width = 0;
			int height = 0;
		};

		inline cv::Mat resize_with_aspect_ratio(
			const cv::Mat& src,
			int target_w,
			int target_h,
			const cv::Scalar& padding_color = cv::Scalar(114, 114, 114))
		{
			if (src.empty()) return {};

			const float scale = std::min(
				static_cast<float>(target_w) / src.cols,
				static_cast<float>(target_h) / src.rows);

			const int new_w = static_cast<int>(src.cols * scale);
			const int new_h = static_cast<int>(src.rows * scale);

			cv::Mat resized;
			cv::resize(src, resized, cv::Size(new_w, new_h));

			cv::Mat output(target_h, target_w, src.type(), padding_color);
			const int x = (target_w - new_w) / 2;
			const int y = (target_h - new_h) / 2;
			resized.copyTo(output(cv::Rect(x, y, new_w, new_h)));

			return output;
		}

		inline letterbox_t compute_letterbox_params(int src_w, int src_h, int target_w, int target_h) {
			letterbox_t lb;
			lb.scale = std::min(
				static_cast<float>(target_w) / src_w,
				static_cast<float>(target_h) / src_h);
			const int new_w = static_cast<int>(src_w * lb.scale);
			const int new_h = static_cast<int>(src_h * lb.scale);
			lb.x_pad = (target_w - new_w) / 2;
			lb.y_pad = (target_h - new_h) / 2;
			return lb;
		}

	} // namespace neural
} // namespace varan