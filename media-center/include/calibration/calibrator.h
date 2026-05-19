#pragma once

#include "bird-view/egl-context.h"
#include "utility/frame-storage.h"
#include "core/image-handler.h"
#include "core/websocket-handler.h"
#include "logger.h"
#include "json-reader.h"

#include "camera.h"

using namespace varan::birdview;
using namespace varan::calibration::utility;

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

		struct FDistotionCoefficientsParameters {
			bool use = false;
			float k1;
			float k2;
			float k3;
			float k4;
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

		void handle_calibration_configuration(const std::string& client_id, const boost::json::object& meta, COnError on_error = nullptr);

		void compute_undistort_maps(
			const std::string& client_id,
			const FCameraMatrixParameters& cammat_pars,
			const FDistotionCoefficientsParameters& dist_pars
		);

		void apply_undistort_maps(const cv::Mat& src, cv::Mat& dst);

	private:

		boost::json::object get_coeffs();

		boost::json::object build_json_calibration();

	private:
		std::string m_camera_id;

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

		FCameraMatrixParameters m_custom_parameters;

		FUndistortMaps m_undistort;
		std::mutex m_undistort_mutex;
		std::atomic<bool> m_apply_undistort;

		std::mutex m_cached_image_mutex;

		std::thread m_calibration_thread;

		std::string m_name{"calibration-server"};
		ULogger m_logger;

		UJsonReader m_json_reader;

	private:
		// Список для карт после проекций
		std::unordered_map<std::string, std::pair<cv::Mat, cv::Mat>> m_warped_mats;

		// Канвас для отображения
		cv::Mat m_canvas;

	};

} // calibration
} // varan