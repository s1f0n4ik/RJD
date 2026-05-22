#pragma once

#include "bird-view/egl-context.h"
#include "utility/frame-storage.h"
#include "core/image-handler.h"
#include "core/websocket-handler.h"
#include "logger.h"
#include "json-calibration.h"
#include "json-projection.h"

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

		void handle_projection_configuration(const std::string& client_id, const boost::json::object& meta, COnError on_error = nullptr);

		void compute_undistort_maps(
			const std::string& client_id,
			const FCameraMatrixParameters& cammat_pars,
			const FDistotionCoefficientsParameters& dist_pars
		);

		void handle_panorama_computation(const std::string& client_id, const boost::json::object& meta, COnError on_error);

		void handle_panorama_toggle(const std::string& client_id, const boost::json::object& meta, COnError on_error);
		
		void compute_panorama_remap(const std::string& client_id, int radius);

		void apply_undistort_maps(const cv::Mat& src, cv::Mat& dst);

	private:

		void handle_save_lut(const std::string& client_id, const boost::json::object& meta, COnError on_error = nullptr);

		bool extract_canvas_dst_points(
			const std::string& camera_key,
			const std::vector<cv::Point2f>& source_points,
			cv::Size& canvas_size, 
			std::vector<cv::Point2f>& dst_points, 
			std::string& str_err
		);

		bool build_warp_remap(
			const std::vector<cv::Point2f>& src_points,
			const std::vector<cv::Point2f>& dst_points,
			const cv::Size& canvas_size,
			cv::Mat& out_map_x,
			cv::Mat& out_map_y,
			std::string& error
		);

		bool build_warp_extras(
			const std::string& camera_key,
			const cv::Mat& map_x,
			const cv::Mat& map_y,
			const cv::Size& snapshot_size,
			const std::vector<cv::Point2f>& canvas_region,
			const std::vector<cv::Point2f>& dst_points
		);

		bool compose_remap_to_raw(
			const cv::Mat& warp_x, const cv::Mat& warp_y,
			const cv::Mat& undist_x, const cv::Mat& undist_y,
			const cv::Size& raw_size,
			cv::Mat& out_remap_32fc2,
			std::string& error
		);

		bool save_stitching_export(
			const std::filesystem::path& export_root,
			const std::string& id,
			const std::string& display_name,
			std::string& error
		);

		bool get_image_to_build(cv::Mat& out, std::string& error);

		bool build_canvas(std::string& error);

		bool send_canvas_as_binary(const std::string& client_id, const boost::json::object& meta, std::string& error);
		
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
		std::atomic<bool> m_use_panorama_remap{false};
		std::atomic<bool> m_apply_undistort{false};

		std::mutex m_cached_image_mutex;

		std::thread m_calibration_thread;

		std::string m_name{"calibration-server"};
		ULogger m_logger;

		UJsonCalibrationConfiguration m_calibration_config;
		UJsonProjectionConfiguration  m_projection_config;

	// часть класса для проецирования в канвас
	private:
		// Скриншоты проекций с камер, по ним строится канвас
		std::unordered_map<std::string, cv::Mat> m_saved_to_warp_camera_images;
		// Список для карт после проекций
		std::unordered_map<std::string, std::pair<cv::Mat, cv::Mat>> m_warped_mats;

		// Канвас для отображения
		cv::Mat m_canvas;

		struct FWarpExtras {
			cv::Mat mask;    // CV_8UC1, canvas size, 0/255
			cv::Mat weight;  // CV_32FC1, canvas size, distance transform внутри маски
		};
		std::unordered_map<std::string, FWarpExtras> m_warp_extras;

		// активный пресет в памяти
		std::optional<FProjectionPreset> m_active_preset;
		std::mutex m_active_preset_mutex;

	};

} // calibration
} // varan