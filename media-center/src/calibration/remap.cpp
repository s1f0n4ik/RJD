#include "calibration/remap.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

#include <opencv2/calib3d.hpp>

#include "calibration/utility.h"

namespace varan::calibration {

	namespace {

		double number(const boost::json::object& source, const char* key, double fallback) {
			const auto* value = source.if_contains(key);
			if (!value) return fallback;
			if (!value->is_number() || !std::isfinite(value->to_number<double>()))
				throw std::runtime_error(std::string(key) + " must be finite");
			return value->to_number<double>();
		}

		cv::Size size_of(const boost::json::object& source) {
			const double width = number(source, "width", 0);
			const double height = number(source, "height", 0);
			if (width < 1 || height < 1 || width > 16384 || height > 16384)
				throw std::runtime_error("invalid remap size");
			return { static_cast<int>(width), static_cast<int>(height) };
		}

		class UFisheyeRemap : public IRemapBuilder {
		public:
			void build(const boost::json::object& source, cv::Mat& x, cv::Mat& y) const override {
				using utility::SBinary;
				const auto k = SBinary::json_object_to_mat(source.at("camera_matrix").as_object());
				const auto d = SBinary::json_object_to_mat(source.at("distortion_coeffs").as_object());
				const auto p = SBinary::json_object_to_mat(source.at("new_K").as_object());
				cv::fisheye::initUndistortRectifyMap(k, d, cv::Mat::eye(3, 3, CV_64F), p,
					size_of(source), CV_16SC2, x, y);
			}
		};

		class UPanoramaRemap : public IRemapBuilder {
		public:
			void build(const boost::json::object& source, cv::Mat& x, cv::Mat& y) const override {
				const auto size = size_of(source);
				const auto& options = source.at("correction").as_object();
				const float radius = static_cast<float>(number(options, "radius", std::min(size.width, size.height) * 0.5));
				if (radius <= 0) throw std::runtime_error("radius must be positive");
				x.create(size, CV_32FC1);
				y.create(size, CV_32FC1);
				const float fov = static_cast<float>(CV_PI);
				for (int row = 0; row < size.height; ++row) {
					const float vertical = -(0.5f - static_cast<float>(row) / size.height) * fov;
					for (int col = 0; col < size.width; ++col) {
						const float horizontal = (static_cast<float>(col) / size.width - 0.5f) * fov;
						const float sx = std::sin(horizontal) * std::cos(vertical);
						const float sy = std::sin(vertical);
						const float sz = std::cos(horizontal) * std::cos(vertical);
						if (sz <= 0) {
							x.at<float>(row, col) = y.at<float>(row, col) = -1;
							continue;
						}
						const float r = radius * std::acos(sz) / (fov * 0.5f);
						const float phi = std::atan2(sy, sx);
						x.at<float>(row, col) = size.width * 0.5f + r * std::cos(phi);
						y.at<float>(row, col) = size.height * 0.5f + r * std::sin(phi);
					}
				}
			}
		};

		class UFovRemap : public IRemapBuilder {
		public:
			void build(const boost::json::object& source, cv::Mat& x, cv::Mat& y) const override {
				const auto size = size_of(source);
				const double degrees = number(source.at("correction").as_object(), "fov", 0);
				if (degrees <= 0 || degrees >= 180) throw std::runtime_error("fov must be within 0..180");
				const float f = size.width / static_cast<float>(degrees * CV_PI / 180);
				x.create(size, CV_32FC1);
				y.create(size, CV_32FC1);
				for (int row = 0; row < size.height; ++row) {
					for (int col = 0; col < size.width; ++col) {
						const float nx = col - size.width * 0.5f, ny = row - size.height * 0.5f;
						const float radius = std::sqrt(nx * nx + ny * ny);
						const float scale = radius < 1e-6f ? 0 : std::tan(radius / f) / radius;
						x.at<float>(row, col) = size.width * 0.5f + nx * scale;
						y.at<float>(row, col) = size.height * 0.5f + ny * scale;
					}
				}
			}
		};

	}

	URemapBuilder::URemapBuilder()
		: m_builders{
			{ "fisheye", [] { return std::make_unique<UFisheyeRemap>(); } },
			{ "panorama", [] { return std::make_unique<UPanoramaRemap>(); } },
			{ "fov", [] { return std::make_unique<UFovRemap>(); } } } {}

	std::string URemapBuilder::build(const boost::json::object& source, cv::Mat& x, cv::Mat& y) const {
		try {
			std::string type = "fisheye";
			if (const auto* options = source.if_contains("correction"))
				type = options->as_object().at("type").as_string().c_str();
			const auto found = m_builders.find(type);
			if (found == m_builders.end()) return "unknown correction type <" + type + ">";
			cv::Mat next_x, next_y;
			found->second()->build(source, next_x, next_y);
			x = std::move(next_x);
			y = std::move(next_y);
			return {};
		}
		catch (const std::exception& error) { return error.what(); }
	}

}
