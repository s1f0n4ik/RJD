#pragma once

#include "bird-view/egl-context.h"
#include "utility/frame-storage.h"
#include "core/image-handler.h"
#include "core/websocket-handler.h"
#include "logger.h"

#include "camera.h"

using namespace varan::birdview;

namespace varan {
namespace calibration {

	class UCalibrator: public UImageHandler, public UWebSocketHandler {
	public:
		
		UCalibrator() = delete;
		UCalibrator(
			const std::string& ip_address,
			const std::string& port,
			birdview::UEGLContextManager* context,
			FFrameStorage<IFrame>* storage,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::TRACE
		);

		void start_websocket_connection();

		void stop_websocket_connection();

	protected:

		virtual void on_signaling_message(const std::string& msg) override;

		virtual void internal_handle_image(cv::Mat rgb_pixels) override;

		void build_fisheye_dewarp_LUT(const std::string& client_id, int width, int height, float fov_deg);
		
	private:

		// const std::string& type, const std::string& err, const std::string* client_id
		using COnError = std::function<void(const std::string& type, const std::string& err, const std::string* client_id)>;

		struct FSizeImage {
			int width = 1920;
			int height = 1080;

			bool operator==(const FSizeImage& other) const {
				return width == other.width && height == other.height;
			}
		};

		struct FCalibratorPattern {
			int width;
			int height;
			float size;

			bool recieved = false;
		};

		struct FCalibrationResult {
			float rms;
			cv::Mat camera_matrix;
			cv::Mat distortion_coeffs;

			bool ready = false;
		};

		struct FUndistortMaps {
			cv::Mat custom_camera_matrix;
			cv::Mat matrix_x;
			cv::Mat matrix_y;
			float alpha = 0.0f;

			bool ready = false;
		};

		const boost::json::object* get_object_field(
			const boost::json::object& obj,
			const char* key,
			std::function<void(const std::string&)> on_error
		);

		const std::string get_string_field(
			const boost::json::object& obj,
			const char* key,
			std::function<void(const std::string&)> on_error
		);

		void handle_image_for_push(cv::Mat image);

		void resize_keep_aspect(const FSizeImage& original, FSizeImage& source, int max_width, int max_height);

		void find_and_draw_cornerns(cv::Mat& image);

		void run_calibration(const std::string& client_id);

		void handle_get_undistort_parameters(const std::string& client_id, const boost::json::object& meta, COnError on_error);

		void handle_undistort_computation(const std::string& client_id, const boost::json::object& meta, COnError on_error = nullptr);

		void compute_undistort_maps(const std::string& client_id, float alpha = 0.0f, bool center = false, float zoom = 1.0f, float shift_x = 1.0f, float shift_y = 1.0f);

		void apply_undistort_maps(const cv::Mat& src, cv::Mat& dst);

	private:

		boost::json::object make_json_object_mat(const cv::Mat& input);

	private:

		FSizeImage m_raw_image;
		// Используется только для push_frames
		FSizeImage m_resized_image;

		cv::Mat m_cached_image;

		std::unique_ptr<neural::UVirtualCamera> m_streamer;

		std::vector<cv::Mat> m_calibration_images;
		std::atomic<bool> m_to_show_chessboard;

		FCalibratorPattern m_pattern;
		std::mutex m_pattern_mutex;

		FCalibrationResult m_calibration;
		std::mutex m_calibration_mutex;

		FUndistortMaps m_undistort;
		std::mutex m_undistort_mutex;
		std::atomic<bool> m_apply_undistort;

		std::mutex m_cached_image_mutex;

		std::thread m_calibration_thread;

		std::string m_name{"calibration-server"};
		ULogger m_logger;
	};

} // calibration
} // varan