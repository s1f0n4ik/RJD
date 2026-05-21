#include "calibration/calibrator.h"
#include "calibration/constants.h"

#include "signaling_definers.h"
#include "calibration/utility.h"

namespace varan {
namespace calibration {

	UCalibrator::UCalibrator(
		const std::string& ip_address,
		const std::string& port,
		birdview::UEGLContextManager* context,
		FFrameStorage<IFrame>* storage,
		ULogger::ELoggerLevel level
	)
		: UImageHandler(context, storage, level, "ImageHandler<Calibrator>")
		, UWebSocketHandler(ip_address, port, level, "WebSocket<Calibrator>")
		, m_name("Calibrator")
		, m_logger(m_name, ULogger::ELoggerLevel::TRACE)
		, m_calibration_config(&m_logger)
		, m_projection_config(&m_logger)
	{
	}

	void UCalibrator::start_websocket_connection() {
		start_websocket_client(constants::calibration_url_server, m_name);
	}

	void UCalibrator::stop_websocket_connection() {
		stop_websocket_client();
	}

	void UCalibrator::on_signaling_message(const std::string& msg) {
		auto on_error = [&](const std::string& type, const std::string& err, const std::string* client_id) {
			send_message(make_socket_error(type, err, client_id, &m_name));
			m_logger.error(err);
		};

		try {
			boost::json::value parsed = boost::json::parse(msg);
			boost::json::object& json_object = parsed.as_object();

			// Узнаем идентификатор клиента
			std::string client_id;
			if (auto* v = json_object.if_contains("client_id"); v && v->is_string()) {
				client_id = v->as_string().c_str();
			}
			else {
				on_error(constants::TYPE_MESSAGE, "Error with message: missing client id!", nullptr);
				return;
			}

			// Смотрим подключения. Обязательное подключение
			std::string type;
			if (auto* v = json_object.if_contains("type"); v && v->is_string()) {
				type = v->as_string().c_str();
			}
			else {
				on_error(constants::TYPE_MESSAGE, "Error with message: missing type message!", &client_id);
				return;
			}

			// Проверяем на наличие заголовка meta
			const boost::json::object* meta = nullptr;
			if (auto* v = json_object.if_contains("meta"); v && v->is_object()) {
				meta = &v->as_object(); // ссылка на оригинал
			}
			else {
				on_error(constants::TYPE_MESSAGE, "Error with message: missing or invalid meta!", &client_id);
				return;
			}

			// Обработка подключения и начало отправки изоб
			if (type == constants::TYPE_CONNECTION) {
				std::string camera_id;
				if (auto* v = meta->if_contains("camera_id"); v && v->is_string()) {
					camera_id = v->as_string().c_str();
					m_camera_id = camera_id;
				}
				else {
					on_error(type, "Error with message: missing camera_id at meta block!", &client_id);
					return;
				}

				int fps = 15;
				if (auto* v = meta->if_contains("fps"); v && v->is_int64()) {
					fps = v->as_int64();
				}

				// Получаем кадры из структуры
				m_raw_image.width = 3040;
				if (auto* v = meta->if_contains("width"); v && v->is_int64()) {
					m_raw_image.width = v->as_int64();
				}
				m_raw_image.height = 1368;
				if (auto* v = meta->if_contains("height"); v && v->is_int64()) {
					m_raw_image.height = v->as_int64();
				}

				// Получаем занчение ресайза, если такое есть
				int max_width = -1;
				if (auto* v = meta->if_contains("max_width"); v && v->is_int64()) {
					max_width = v->as_int64();
				}
				int max_height = -1;
				if (auto* v = meta->if_contains("max_height"); v && v->is_int64()) {
					max_height = v->as_int64();
				}
				if (max_width == -1 || max_height == -1) {
					m_resized_image = m_raw_image;
				}
				else {
					resize_keep_aspect(m_raw_image, m_resized_image, max_width, max_height);
				}
				m_logger.info("New resized stream is: " + std::to_string(m_resized_image.width) + ", " + std::to_string(m_resized_image.height));

				try {
					m_streamer = std::make_unique<neural::UVirtualCamera>(
						constants::CALIBRATION_STREAM_ID,
						FWebSocketOptions{ m_ip_adress, m_port }
					);
					if (!m_streamer) {
						send_message(make_socket_error(type, "NV12 encoder pipeline didn't create", &client_id, &m_name));
						return;
					}
					if (!m_streamer->set_parameters(m_resized_image.width, m_resized_image.height, fps)) {
						send_message(make_socket_error(type, "error with set up nv12 encoder parameters", &client_id, &m_name));
						return;
					}
					if (!m_streamer->initialize()) {
						send_message(make_socket_error(type, "NV12 encoder pipeline didn't set", &client_id, &m_name));
						return;
					}
					if (!m_streamer->start()) {
						send_message(make_socket_error(type, "NV12 encoder didn't start!", &client_id, &m_name));
						return;
					}

					if (!start_handler_thread(camera_id, fps, nullptr)) {
						m_streamer->stop();
						m_streamer.release();
						std::string err_str = "Cannot start processing thread for calibration, release streaming!";
						m_logger.warn(err_str);
						send_message(make_socket_error(type, err_str, &client_id, &m_name));
						return;
					}

					boost::json::object send_meta;
					send_meta[constants::META_ID_STREAM] = constants::CALIBRATION_STREAM_ID;
					m_calibration_images.clear();
					send_message(make_socket_message(type, true, &client_id, &m_name, &send_meta));
					m_logger.info("Calibration stream successfully started!");
				}
				catch (const std::exception& err) {
					m_logger.error("on_signaling_message(): exception: " + std::string(err.what()));
					send_message(make_socket_error(type, err.what(), &client_id, &m_name));
					return;
				}
				m_logger.info("on_signaling_message(): started image calibration view thread!");
			}
			else if (type == constants::TYPE_CLOSE) {
				stop_handler_thread();
				if (m_streamer) {
					m_streamer->stop();
					m_streamer.release();
				}
				send_message(make_socket_message(type, true, &client_id, &m_name));
				m_calibration_images.clear();
				m_logger.info("on_signaling_message(): close request suggested!");
				return;
			}
			else if (type == constants::TYPE_SET_PATTERN) {
				int width_pattern;
				if (auto* v = meta->if_contains(constants::META_PATTERN_WIDTH); v && v->is_int64()) {
					width_pattern = v->as_int64();
				}
				else {
					on_error(type, "Error with message: missing or invalid <width> at meta block!", &client_id);
					return;
				}

				int height_pattern;
				if (auto* v = meta->if_contains(constants::META_PATTERN_HEIGHT); v && v->is_int64()) {
					height_pattern = v->as_int64();
				}
				else {
					on_error(type, "Error with message: missing or invalid <height> at meta block!", &client_id);
					return;
				}

				float size_pattern;
				if (auto* v = meta->if_contains(constants::META_PATTERN_SIZE); v && v->is_number()) {
					if (v->is_double()) {
						size_pattern = v->as_double();
					}
					else if (v->is_int64()) {
						size_pattern = static_cast<float>(v->is_int64());
					}
					else {
						on_error(type, "Error with message: invalid type for <size>!", &client_id);
						return;
					}
				}
				else {
					on_error(type, "Error with message: missing or invalid <size> at meta block!", &client_id);
					return;
				}

				{
					std::unique_lock<std::mutex> lock(m_pattern_mutex);
					m_pattern.size = size_pattern;
					m_pattern.width = width_pattern;
					m_pattern.height = height_pattern;
					m_pattern.recieved = true;
				}

				boost::json::object send_meta;
				send_meta[constants::META_PATTERN_WIDTH] = m_pattern.width;
				send_meta[constants::META_PATTERN_HEIGHT] = m_pattern.height;
				send_meta[constants::META_PATTERN_SIZE] = m_pattern.size;

				send_message(make_socket_message(constants::TYPE_GET_PATTERN, true, &client_id, &m_name, &send_meta));
				m_logger.info("on_signaling_message(): recieved calibratuon pattern");
			}
			else if (type == constants::TYPE_CHESSBOARD) {
				if (auto* v = meta->if_contains("show"); v && v->is_bool()) {
					m_to_show_chessboard = v->as_bool();
					boost::json::object send_meta;
					send_meta[constants::META_SHOW] = m_to_show_chessboard;
					send_message(make_socket_message(type, true, &client_id, &m_name, &send_meta));
				}
				else {
					on_error(type, "Error with message: missing show at meta block!", &client_id);
					return;
				}
			}
			else if (type == constants::TYPE_ADD_IMAGE) {
				if (m_calibration_images.size() >= 50) {
					std::string str_err = "Unable to add a new image to the calibration dataset: size limit exceeded. Maximum number of images: 50";
					on_error(type, str_err, &client_id);
					m_logger.warn("on_signaling_message(): " + str_err);
					return;
				}
				//auto cached_image = std::move(m_cached_image);
				if (m_cached_image.empty()) {
					std::string str_err = "Received image is empty; cannot be used for calibration.";
					on_error(type, str_err, &client_id);
					m_logger.warn("on_signaling_message(): " + str_err);
					return;
				}

				boost::json::object send_meta;
				int added_id = m_calibration_images.size();
				send_meta[constants::META_ADDED_ID] = added_id;
				{
					std::unique_lock<std::mutex> lk(m_cached_image_mutex);
					m_calibration_images.push_back(std::move(m_cached_image));
				}
				send_meta[constants::META_COUNT] = m_calibration_images.size();

				send_message(make_socket_message(type, true, &client_id, &m_name, &send_meta));
				m_logger.info((std::ostringstream() << "Image successfully added to the calibration dataset with ID: " 
					            << added_id << " . Total count: " << m_calibration_images.size()).str());
			}
			else if (type == constants::TYPE_DELETE_IMAGE) {
				int delete_id;
				if (auto* v = meta->if_contains(constants::META_ID); v && v->is_int64()) {
					delete_id = v->as_int64();
				}
				else {
					on_error(type, "Error with message: missing or invalid <id> at meta block!", &client_id);
					return;
				}
				
				bool b_all;
				if (auto* v = meta->if_contains(constants::META_DELETE_ALL); v && v->is_bool()) {
					b_all = v->as_bool();
				}
				else {
					on_error(type, "Error with message: missing or invalid <all> at meta block!", &client_id);
					return;
				}

				boost::json::object send_meta;
				send_meta[constants::META_ID] = delete_id;
				send_meta[constants::META_DELETE_ALL] = b_all;
				// Удаляем все, если такой запрос
				if (b_all) {
					m_calibration_images.clear();
					send_meta[constants::META_COUNT] = 0;
					send_message(make_socket_message(type, true, &client_id, &m_name, &send_meta));
					return;
				}

				// Проверка ID
				if (delete_id < 0 || delete_id >= m_calibration_images.size()) {
					on_error(type, "ID " + std::to_string(delete_id) + " doesn't exist", &client_id);
					return;
				}
				else {
					m_calibration_images.erase(m_calibration_images.begin() + delete_id);
					send_meta[constants::META_COUNT] = m_calibration_images.size();
					send_message(make_socket_message(type, true, &client_id, &m_name, &send_meta));
					return;
				}
			}
			else if (type == constants::TYPE_GET_IMAGE) {
				int image_id = -1;
				if (auto* v = meta->if_contains(constants::META_ID); v && v->is_int64()) {
					image_id = v->as_int64();
				}
				else {
					on_error(type, "Error with message: missing or invalid <id> at meta block!", &client_id);
					return;
				}

				if (image_id < 0 || image_id >= m_calibration_images.size()) {
					on_error(type, "ID " + std::to_string(image_id) + " doesn't exist", &client_id);
					return;
				}

				std::vector<uint8_t> buf;
				try {
					auto frame = m_calibration_images[image_id];
					cv::imencode(".jpg", frame, buf, { cv::IMWRITE_JPEG_QUALITY, 80 });
				}
				catch (const std::exception& err) {
					on_error(type, "Internal error: " + std::string(err.what()), &client_id);
					return;
				}

				boost::json::object send_meta;
				send_meta[constants::META_ID] = image_id;
				send_binary(make_socket_message(type, true, &client_id, &m_name, &send_meta, &buf));
				m_logger.info("on_signaling_message(): successfully transported image with id=" + std::to_string(image_id));
				return;
			}
			else if (type == constants::TYPE_STATUS) {
				boost::json::object send_meta;
				send_meta = build_json_calibration();
				send_message(make_socket_message(type, true, &client_id, &m_name, &send_meta));
				m_logger.info("on_signaling_message(): successfully transported calibration status");
				return;
			}
			else if (type == constants::TYPE_GET_PATTERN) {
				if (m_pattern.recieved == false) {
					std::string err_text = "Pattern is't set, cannot send distortion parameters";
					on_error(type, err_text, &client_id);
					m_logger.error("on_signaling_message(): " + err_text);
					return;
				}
				boost::json::object send_meta;
				send_meta[constants::META_PATTERN_WIDTH] = m_pattern.width;
				send_meta[constants::META_PATTERN_HEIGHT] = m_pattern.height;
				send_meta[constants::META_PATTERN_SIZE] = m_pattern.size;

				send_message(make_socket_message(type, true, &client_id, &m_name, &send_meta));
				m_logger.info("on_signaling_message(): successfully transported pattern parameters");
				return;
			}
			else if (type == constants::TYPE_GET_DISTOTION) {
				if (m_calibration.ready == false) {
					std::string err_text = "Calibration is't ready, cannot send distortion parameters";
					on_error(type, err_text, &client_id);
					m_logger.error("on_signaling_message(): " + err_text);
					return;
				}
				boost::json::object send_meta;
				send_meta[constants::META_RMS] = m_calibration.rms;
				send_meta[constants::META_CAMERA_MATRIX] = SBinary::make_json_object_mat(m_calibration.camera_matrix);
				send_meta[constants::META_DISTORION_COEFFS] = SBinary::make_json_object_mat(m_calibration.distortion_coeffs);

				send_message(make_socket_message(type, true, &client_id, &m_name, &send_meta));
				m_logger.info("on_signaling_message(): successfully transported distortion parameters");
				return;
			}
			else if (type == constants::TYPE_CALIBRATION_START) {
				run_calibration(client_id);
				return;
			}
			else if (type == constants::TYPE_GET_UNDISTORT_PARAMETERS) {
				try {
					handle_get_undistort_parameters(client_id, *meta, on_error);
				}
				catch (const std::exception& error) {
					send_message(make_socket_error(type, "Error with sending undistort parameters: " + std::string(error.what()), &client_id, &m_name));
					return;
				}
			}
			else if (type == constants::TYPE_UNDISTORT_COMPUTE) {
				try {
					handle_undistort_computation(client_id, *meta, on_error);
				}
				catch (const std::exception& error) {
					send_message(make_socket_error(type, "Error with computing image correction: " + std::string(error.what()), &client_id, &m_name));
					return;
				}
			}
			else if (type == constants::TYPE_VIEW_UNDISTORT) {
				bool show = false;

				if (auto* v = meta->if_contains(constants::META_SHOW); v && v->is_bool()) {
					show = v->as_bool();
				}
				else {
					on_error(type, "Missing field <show> at message!", &client_id);
					return;
				}

				auto send_undistort_error = [&]() {
					boost::json::object send_meta;
					send_meta[constants::META_SHOW] = false;

					std::string error_msg = "Error with computing image correction: Undistort correction doesn't ready: cannot show undistortion";
					send_message(make_socket_error(type, error_msg, &client_id, &m_name));
				};

				if (!m_undistort.ready) {
					if (!m_calibration.ready) {
						send_undistort_error();
						return;
					}

					compute_undistort_maps(client_id, m_custom_parameters, { false, 0, 0, 0, 0 } );

					if (!m_undistort.ready) {
						send_undistort_error();
						return;
					}
				}

				m_apply_undistort = show;
				boost::json::object send_meta;
				send_meta[constants::META_SHOW] = m_apply_undistort;
				send_message(make_socket_message(type, true, &client_id, &m_name, &send_meta));

				m_logger.debug("Set undistort correction to: " + std::to_string(m_apply_undistort));

				return;
			}
			else if (type == constants::TYPE_CALIBRATION_CONFIGURATION) {
				try {
					handle_calibration_configuration(client_id, *meta, on_error);
					return;
				}
				catch (const std::exception& error) {
					send_message(make_socket_error(type, "Error with computing image correction: " + std::string(error.what()), &client_id, &m_name));
					return;
				}
			}
			else if (type == constants::TYPE_PROJECTION_CONFIGURATION) {
				try {
					handle_projection_configuration(client_id, *meta, on_error);
					return;
				}
				catch (const std::exception& error) {
					send_message(make_socket_error(type, "Error with handle projection: " + std::string(error.what()), &client_id, &m_name));
					return;
				}
			}
			else {
				on_error(constants::TYPE_MESSAGE, "Error with message: unsupported type <" + type + ">!", &client_id);
				return;
			}

		}
		catch (const std::exception& e) {
			on_error(constants::TYPE_MESSAGE, "Error with message: " + std::string(e.what()), nullptr);
		}
	}

	void UCalibrator::internal_handle_image(cv::Mat rgba_pixels) {
		if (!m_streamer) {
			return;
		}

		handle_image_for_push(std::move(rgba_pixels));
	}

	void UCalibrator::handle_image_for_push(cv::Mat image) {
		if (image.empty()) {
			return;
		}
		// Кешируем неизмененный фрейм
		{
			std::unique_lock<std::mutex> lk(m_cached_image_mutex);
			m_cached_image = image.clone();
			if (image.channels() == 4) {
				cv::cvtColor(image, m_cached_image, cv::COLOR_BGRA2RGB);
			}
			else if (image.channels() == 3) {
				cv::cvtColor(image, m_cached_image, cv::COLOR_BGR2RGB);
			}
			else {
				m_logger.trace("Unsupported image format!");
			}
		}

		cv::Mat undistorted;
		if (m_apply_undistort) {
			undistorted.create(image.size(), image.type());
			apply_undistort_maps(image, undistorted);
		}
		else {
			undistorted = std::move(image);
		}

		cv::Mat to_push;
		// Првоеряем нужно ли делать resize
		if (m_resized_image != m_raw_image) {
			cv::resize(
				undistorted,
				to_push,
				cv::Size(m_resized_image.width, m_resized_image.height),
				0, 0,
				cv::INTER_AREA
			);
		}
		else {
			to_push = std::move(undistorted);
		}

		if (m_to_show_chessboard) {
			find_and_draw_cornerns(to_push);
		}

		if (m_streamer) m_streamer->push_frame(std::move(to_push));
	}

	void UCalibrator::run_calibration(const std::string& client_id) {
		if (m_calibration_images.empty()) {
			send_message(make_socket_error(constants::TYPE_CALIBRATION_START, "No images for calibration", &client_id, &m_name));
			return;
		}

		if (!m_pattern.recieved) {
			send_message(make_socket_error(constants::TYPE_CALIBRATION_START, "Pattern not set", &client_id, &m_name));
			return;
		}

		boost::json::object meta;
		meta[constants::META_TOTAL] = m_calibration_images.size();
		send_message(make_socket_message(constants::TYPE_CALIBRATION_START, true, &client_id, &m_name, &meta));

		auto send_step_result = [this, client_id](int index, int total, bool result) {
			boost::json::object meta;
			meta[constants::META_CURRENT_COUNT] = index + 1;
			meta[constants::META_TOTAL] = total;
			meta[constants::META_ID] = index;
			meta[constants::META_CORNERS_FOUND] = result;

			send_message(make_socket_message(constants::TYPE_CALIBRATION_PROGRESS, true, &client_id, &m_name, &meta));
		};

		m_calibration_thread = std::thread([this, client_id, send_step_result]() {

			const cv::Size pattern_size(m_pattern.width, m_pattern.height);
			const int total = static_cast<int>(m_calibration_images.size());

			// 3D точки одного паттерна
			std::vector<cv::Point3f> single_object_points;
			for (int r = 0; r < m_pattern.height; ++r) {
				for (int c = 0; c < m_pattern.width; ++c) {
					single_object_points.emplace_back(c * m_pattern.size, r * m_pattern.size, 0.f);
				}
			}

			std::vector<std::vector<cv::Point3f>> object_points;
			std::vector<std::vector<cv::Point2f>> image_points;

			// ограничение на калибровку, 10 процентов кадра - минимум занимает шахматка
			const double min_area_ratio = 0.1;

			// Поиск углов на наших скриншотах
			for (int i = 0; i < total; ++i) {
				const cv::Mat& image = m_calibration_images[i];

				cv::Mat gray;
				if (image.channels() == 4) {
					cv::cvtColor(image, gray, cv::COLOR_BGRA2GRAY);
				}
				else if (image.channels() == 3) {
					cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
				}
				else if (image.channels() == 1) {
					gray = image;
				}
				else {
					m_logger.warn("run_calibration(): unsupported format image " + std::to_string(i));

					send_step_result(i, total, false);
					continue;
				}

				std::vector<cv::Point2f> corners;
				// Использование точного алгоритма
				bool found = cv::findChessboardCorners(
					gray,
					pattern_size,
					corners,
					cv::CALIB_CB_ADAPTIVE_THRESH | cv::CALIB_CB_NORMALIZE_IMAGE
				);
				bool chess_result = found && (corners.size() == pattern_size.area());

				if (!chess_result || corners.size() != pattern_size.area()) {
					send_step_result(i, total, false);
					m_logger.warn("run_calibration(): corners not found on image " + std::to_string(i));
					continue;
				}

				cv::cornerSubPix(gray, corners, cv::Size(5, 5), cv::Size(-1, -1), 
					cv::TermCriteria(cv::TermCriteria::EPS + cv::TermCriteria::MAX_ITER, 50, 0.001));

				// Проверка на углы
				bool valid = true;
				for (const auto& p : corners) {
					if (!std::isfinite(p.x) || !std::isfinite(p.y)) {
						valid = false;
						break;
					}
				}
				if (!valid) {
					m_logger.warn("Invalid corners (NaN) on frame " + std::to_string(i));
					send_step_result(i, total, false);
					continue;
				}

				send_step_result(i, total, true);
				object_points.push_back(single_object_points);
				image_points.push_back(corners);
			}

			if (image_points.size() < 6) {
				send_message(make_socket_error(constants::TYPE_CALIBRATION_RESULT,
					"Not enough images with detected corners (need at least 6-10)",
					&client_id, &m_name));
				return;
			}

			m_logger.debug("=== Calibration input check ===");
			m_logger.debug("object_points sets: " + std::to_string(object_points.size()));
			m_logger.debug("image_points sets:  " + std::to_string(image_points.size()));

			if (!object_points.empty()) {
				const auto& op = object_points[0];
				m_logger.debug("obj[0][0]: " + std::to_string(op[0].x) + " " + std::to_string(op[0].y));
				m_logger.debug("obj[0][last]: " + std::to_string(op.back().x) + " " + std::to_string(op.back().y));
			}

			if (!image_points.empty()) {
				const auto& ip = image_points[0];
				m_logger.debug("img[0][0]: " + std::to_string(ip[0].x) + " " + std::to_string(ip[0].y));
				m_logger.debug("img[0][last]: " + std::to_string(ip.back().x) + " " + std::to_string(ip.back().y));
			}

			send_message(make_socket_message(constants::TYPE_CALIBRATION_COMPUTE, true, &client_id, &m_name));

			// Само вычисление
			const cv::Size image_size(m_calibration_images[0].cols, m_calibration_images[0].rows);

			cv::Mat camera_matrix = cv::Mat::eye(3, 3, CV_64F);
			camera_matrix.at<double>(0, 0) = image_size.width * 0.3;
			camera_matrix.at<double>(1, 1) = image_size.width * 0.3;
			camera_matrix.at<double>(0, 2) = image_size.width / 2.0;
			camera_matrix.at<double>(1, 2) = image_size.height / 2.0;
			cv::Mat dist_coeffs = cv::Mat::zeros(4, 1, CV_64F);
			std::vector<cv::Mat> rvecs, tvecs;

			double rms = 0;
			try {
				rms = cv::fisheye::calibrate(
					object_points, image_points,
					image_size,
					camera_matrix, dist_coeffs,
					rvecs, tvecs,
					cv::fisheye::CALIB_RECOMPUTE_EXTRINSIC |
					cv::fisheye::CALIB_FIX_SKEW |
					cv::fisheye::CALIB_USE_INTRINSIC_GUESS
				);

				// Проверка reprojection error
				double total_err = 0;
				for (size_t i = 0; i < object_points.size(); i++) {
					std::vector<cv::Point2f> projected;
					cv::fisheye::projectPoints(
						object_points[i],
						projected,
						rvecs[i],
						tvecs[i],
						camera_matrix,
						dist_coeffs
					);

					double err = cv::norm(image_points[i], projected, cv::NORM_L2)/ projected.size();
					if (err >= 1.0f) {
						m_logger.warn("calibration: representation error of image_id=" + std::to_string(i) + " is " + std::to_string(err));
						boost::json::object send_meta;
						send_meta[constants::META_ID] = i;
						send_meta[constants::META_CORNERS_FOUND] = false;
						send_message(make_socket_message(constants::TYPE_CALIBRATION_POST_PROCESS, true, &client_id, &m_name, &send_meta));
					}
					std::cout << "frame " << i << " err = " << err << std::endl;
				}
			}
			catch (const std::exception& error) {
				send_message(make_socket_error(constants::TYPE_CALIBRATION_RESULT, error.what(), &client_id, &m_name));
				return;
			}

			// Сохранение результатов
			{
				std::unique_lock<std::mutex> lock(m_calibration_mutex);
				m_calibration.camera_matrix = camera_matrix.clone();
				m_calibration.distortion_coeffs = dist_coeffs.clone();
				m_calibration.ready = true;
			}

			m_logger.info("run_calibration(): RMS=" + std::to_string(rms));

			// Отправка рещультатов
			boost::json::object meta;
			meta[constants::META_WIDTH] = m_raw_image.width;
			meta[constants::META_HEIGHT] = m_raw_image.height;
			meta[constants::META_RMS] = rms;
			meta[constants::META_USED_IMAGES] = static_cast<int>(image_points.size());
			meta[constants::META_TOTAL] = total;

			meta[constants::META_DISTORION_COEFFS] = SBinary::make_json_object_mat(dist_coeffs);

			send_message(make_socket_message(constants::TYPE_CALIBRATION_RESULT, true, &client_id, &m_name, &meta));
		});

		m_calibration_thread.detach();
	}

	void UCalibrator::handle_get_undistort_parameters(const std::string& client_id, const boost::json::object& meta, COnError on_error) {
		if (!m_calibration.ready || m_calibration.camera_matrix.empty()) {
			if (on_error) on_error(constants::TYPE_GET_UNDISTORT_PARAMETERS, "Calibration didn't procces, null at undistort parameters!", &client_id);
			return;
		}

		boost::json::object send_meta;
		send_meta[constants::META_ZOOM] = m_undistort.ready ? m_undistort.custom_camera_matrix.at<double>(0, 0) / m_calibration.camera_matrix.at<double>(0, 0) 
			                                                : 1.0f;
		send_meta[constants::META_SHIFT_X] = m_undistort.ready ? m_undistort.custom_camera_matrix.at<double>(0, 2) 
			                                                   : m_calibration.camera_matrix.at<double>(0, 2);
		send_meta[constants::META_SHIFT_Y] = m_undistort.ready ? m_undistort.custom_camera_matrix.at<double>(1, 2) 
			                                                   : m_calibration.camera_matrix.at<double>(1, 2);

		send_message(make_socket_message(constants::TYPE_GET_UNDISTORT_PARAMETERS, true, &client_id, &m_name, &send_meta));
	}

	void UCalibrator::handle_undistort_computation(const std::string& client_id, const boost::json::object& meta, COnError on_error) {
		if (!m_calibration.ready) {
			send_message(make_socket_error(constants::TYPE_UNDISTORT_COMPUTE, "Cannot compute undistort maps: calibration didn't ready!", &client_id, &m_name));
			return;
		}
		
		auto get_float_from_meta = [&](
			const boost::json::object& obj,
			const std::string& key,
			float& out
		) -> bool {
			try {
				auto it = obj.if_contains(key);
				if (!it) {
					throw std::runtime_error("missing key");
				}

				out = static_cast<float>(boost::json::value_to<double>(*it));

				return true;
			}
			catch (...) {
				if (on_error) {
					on_error(constants::TYPE_UNDISTORT_COMPUTE,
						std::string("Error with message: missing or invalid <") +
						key + "> at meta block!",
						&client_id);
				}
				return false;
			}
		};

		float alpha = 0.0f;
		if (!get_float_from_meta(meta, constants::META_ALPHA, alpha)) return;

		float zoom = 1.0f;
		if (!get_float_from_meta(meta, constants::META_ZOOM, zoom)) return;

		float shift_x = 0.0f;
		if (!get_float_from_meta(meta, constants::META_SHIFT_X, shift_x)) return;

		float shift_y = 0.0f;
		if (!get_float_from_meta(meta, constants::META_SHIFT_Y, shift_y)) return;

		bool k_block_exists = true;
		float k1 = 0, k2 = 0, k3 = 0, k4 = 0;
		if (!get_float_from_meta(meta, constants::META_K1, k1)) k_block_exists = false;
		if (!get_float_from_meta(meta, constants::META_K2, k2)) k_block_exists = false;
		if (!get_float_from_meta(meta, constants::META_K3, k3)) k_block_exists = false;
		if (!get_float_from_meta(meta, constants::META_K4, k4)) k_block_exists = false;

		std::ostringstream oss;
		oss << "handle_undistort_computation(): Start correction image with parameters: alpha=" << alpha 
			<< ", zoom=" << zoom << ", shift_x=" << shift_x << ", shift_y=" << shift_y << ";";
		m_logger.debug(oss.str());

		//build_fisheye_dewarp_LUT(client_id, m_raw_image.width, m_raw_image.height, 180.0);
		compute_undistort_maps(client_id, 
			{ alpha, zoom, shift_x, shift_y },
			{ k_block_exists, k1, k2, k3, k4}
		);
	}

	void UCalibrator::compute_undistort_maps(
		const std::string& client_id, 
		const FCameraMatrixParameters& cammat_pars, 
		const FDistotionCoefficientsParameters& dist_pars
	) {
		if (!m_calibration.ready) {
			send_message(make_socket_error(constants::TYPE_UNDISTORT_COMPUTE, "Cannot compute undistort maps: calibration didn't ready!", &client_id, &m_name));
			return;
		}

		if (dist_pars.use) {
			m_calibration.distortion_coeffs.at<double>(0, 0) = dist_pars.k1;
			m_calibration.distortion_coeffs.at<double>(1, 0) = dist_pars.k2;
			m_calibration.distortion_coeffs.at<double>(2, 0) = dist_pars.k3;
			m_calibration.distortion_coeffs.at<double>(3, 0) = dist_pars.k4;
		}

		//auto ROI = cv::Rect(0, 0, m_raw_image.height, m_raw_image.height);
		auto image_size = cv::Size(m_raw_image.width, m_raw_image.height);
		cv::Mat R = cv::Mat::eye(3, 3, CV_64F);
		// Вычисление новой матрицы K
		cv::Mat P = m_calibration.camera_matrix.clone();
		P.at<double>(0, 0) = m_calibration.camera_matrix.at<double>(0, 0) * cammat_pars.zoom;
		P.at<double>(1, 1) = m_calibration.camera_matrix.at<double>(1, 1) * cammat_pars.zoom;
		P.at<double>(0, 2) = image_size.width / 2.0 + cammat_pars.shift_x;
		P.at<double>(1, 2) = image_size.height / 2.0 + cammat_pars.shift_y;

		m_custom_parameters.alpha = cammat_pars.alpha;
		m_custom_parameters.zoom = cammat_pars.zoom;
		m_custom_parameters.shift_x = cammat_pars.shift_x;
		m_custom_parameters.shift_y = cammat_pars.shift_y;

		{
			std::ostringstream oss;

			oss << "\n=== UNDISTORT PARAMETERS ===\n";
			oss << "Image size: " << image_size << "\n";
			oss << "Balance: " << cammat_pars.alpha << "\n";
			oss << "Zoom: " << cammat_pars.zoom << "\n";
			oss << "Shift X: " << cammat_pars.shift_x << "\n";
			oss << "Shift Y: " << cammat_pars.shift_y << "\n";
			oss << "\nK:\n" << m_calibration.camera_matrix << "\n";
			oss << "\nD:\n" << m_calibration.distortion_coeffs << "\n";
			oss << "\nP:\n" << P << "\n";

			m_logger.info(oss.str());
		}

		m_undistort.custom_camera_matrix = P;

		// Сама генерация
		cv::fisheye::initUndistortRectifyMap(
			m_calibration.camera_matrix, 
			m_calibration.distortion_coeffs, 
			R, 
			m_undistort.custom_camera_matrix, 
			image_size, 
			CV_16SC2,
			m_undistort.matrix_x, 
			m_undistort.matrix_y
		);

		boost::json::object send_meta = get_coeffs();
		send_message(make_socket_message(constants::TYPE_UNDISTORT_COMPUTE, true, &client_id, &m_name, &send_meta));
		m_logger.debug("compute_undistort_maps(): Successfully computed undistort maps!");
		m_undistort.ready = true;
	}

	void UCalibrator::handle_calibration_configuration(const std::string& client_id, const boost::json::object& meta, COnError on_error) {
		std::string method;
		if (auto* v = meta.if_contains(constants::META_CONFIGURATION_METHOD); v && v->is_string()) {
			method = v->as_string();
		}
		else {
			on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error with message: missing or invalid <method> at meta block!", &client_id);
			return;
		}

		if (method == constants::METHOD_CONFIGURATION_GET_LIST) {
			if (!m_calibration_config.read(constants::CALIBRATION_CONFIGURES_PATH)) {
				if (on_error) on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error: cannot read configuration file at server!", &client_id);
				return;
			}
			auto configs = m_calibration_config.get_cameras_info();

			boost::json::object send_meta;
			send_meta[constants::META_CONFIGURATION_METHOD] = constants::METHOD_CONFIGURATION_GET_LIST;
			send_meta[constants::META_CAMERA_BASE_CONFIGS] = configs;
			send_message(make_socket_message(constants::TYPE_CALIBRATION_CONFIGURATION, true, &client_id, &m_name, &send_meta));
			return;
		}
		else if (method == constants::METHOD_CONFIGURATION_GET_ITEM) {
			std::string config_key;
			if (auto* v = meta.if_contains(constants::META_CONFIGURATION_CONFIG_KEY); v && v->is_string()) {
				config_key = v->as_string();
			}
			else {
				on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error with message: missing or invalid <config_key> at meta block!", &client_id);
				return;
			}

			if (!m_calibration_config.read(constants::CALIBRATION_CONFIGURES_PATH)) {
				if (on_error) on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error: cannot read configuration file at server!", &client_id);
				return;
			}

			try {
				auto result = m_calibration_config.get_sender_json_item(config_key);

				boost::json::object send_meta;
				send_meta[constants::META_CONFIGURATION_METHOD] = METHOD_CONFIGURATION_GET_ITEM;
				send_meta[constants::META_CONFIGURATION_CONFIG_ITEM] = result;
				send_message(make_socket_message(constants::TYPE_CALIBRATION_CONFIGURATION, true, &client_id, &m_name, &send_meta));
				return;
			}
			catch (const std::exception& error) {
				on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Server error: " + std::string(error.what()), &client_id);
				return;
			}
		}
		else if (method == constants::METHOD_CONFIGURATION_SAVE) {
			if (m_camera_id.empty()) {
				if (on_error) on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error: save cinfigurations: no camera_id at server!", &client_id);
				return;
			}
			if (!m_calibration_config.read(constants::CALIBRATION_CONFIGURES_PATH)) {
				if (on_error) on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error: cannot read configuration file at server!", &client_id);
				return;
			}

			std::string key;
			if (auto* v = meta.if_contains(constants::META_CONFIGURATION_CONFIG_KEY); v && v->is_string()) {
				key = v->as_string();
			}
			else {
				key = UJsonCalibrationConfiguration::make_item_key(m_camera_id, m_raw_image.width, m_raw_image.height);
			}

			boost::json::object obj_t;
			// обязательные поля
			obj_t[constants::JSON_ID] = m_camera_id;
			obj_t[constants::JSON_WIDTH] = m_raw_image.width;
			obj_t[constants::JSON_HEIGHT] = m_raw_image.height;

			// Если есть паттерн
			if (m_pattern.recieved) {
				obj_t[constants::JSON_PATTERN_WIDTH] = m_pattern.width;
				obj_t[constants::JSON_PATTERN_HEIGHT] = m_pattern.height;
				obj_t[constants::JSON_PATTERN_SIZE] = m_pattern.size;
			}

			if (m_calibration.ready) {
				// Кастомные поля
				obj_t[constants::META_ALPHA] = m_custom_parameters.alpha;
				obj_t[constants::META_ZOOM] = m_custom_parameters.zoom;
				obj_t[constants::META_SHIFT_X] = m_custom_parameters.shift_x;
				obj_t[constants::META_SHIFT_Y] = m_custom_parameters.shift_y;
				// Основа калибровки
				obj_t[constants::JSON_RMS] = m_calibration.rms;
				obj_t[constants::JSON_CAMERA_MATRIX] = SBinary::make_json_object_mat(m_calibration.camera_matrix);
				obj_t[constants::JSON_DISTORTION_COEFFS] = SBinary::make_json_object_mat(m_calibration.distortion_coeffs);
			}

			// Если была проделана коррекция изображений
			if (m_undistort.ready) {
				obj_t[constants::JSON_NEW_K] = SBinary::make_json_object_mat(m_undistort.custom_camera_matrix);
				auto filename_map_x = std::filesystem::path(key + "_map_x.bin");
				auto filename_map_y = std::filesystem::path(key + "_map_y.bin");
				if (SBinary::save_mat_to_binary(constants::CALIBRATION_MAPS_PATH / filename_map_x, m_undistort.matrix_x, &m_logger)) {
					obj_t[constants::JSON_UNDISTORTION_MAP_X] = filename_map_x.string();
				}
				if (SBinary::save_mat_to_binary(constants::CALIBRATION_MAPS_PATH / filename_map_y, m_undistort.matrix_y, &m_logger)) {
					obj_t[constants::JSON_UNDISTORTION_MAP_Y] = filename_map_y.string();
				}
			}

			m_calibration_config.add_json_item(key, obj_t);
			m_calibration_config.save(constants::CALIBRATION_CONFIGURES_PATH);

			boost::json::object send_meta;
			send_meta[constants::META_CONFIGURATION_METHOD] = constants::METHOD_CONFIGURATION_SAVE;
			send_message(make_socket_message(constants::TYPE_CALIBRATION_CONFIGURATION, true, &client_id, &m_name, &send_meta));
			return;
		}
		else if (method == constants::METHOD_CONFIGURATION_LOAD) {
			if (m_camera_id.empty()) {
				if (on_error) on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error: load configuration: no camera_id at server!", &client_id);
				return;
			}
			if (!m_calibration_config.read(constants::CALIBRATION_CONFIGURES_PATH)) {
				if (on_error) on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error: cannot read configuration file at server!", &client_id);
				return;
			}

			std::string key;
			if (auto* v = meta.if_contains(constants::META_CONFIGURATION_CONFIG_KEY); v && v->is_string()) {
				key = v->as_string();
			}
			else {
				if (on_error) on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error: cannot read configuration at server!", &client_id);
				return;
			}

			auto opt_obj = m_calibration_config.get_json_item(key);
			if (!opt_obj) {
				if (on_error) on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error: load configuration: key not found: " + key, &client_id);
				return;
			}
			const auto& obj = *opt_obj;

			// Обязательные поля
			if (!UJsonCalibrationConfiguration::contains_required_fields(obj)) {
				if (on_error) on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error: load configuration: missing required fields!", &client_id);
				return;
			}

			try {
				const auto json_id = obj.at(constants::JSON_ID).as_string();
				const auto json_width = static_cast<int>(obj.at(constants::JSON_WIDTH).as_int64());
				const auto json_height = static_cast<int>(obj.at(constants::JSON_HEIGHT).as_int64());

				if (json_width != m_raw_image.width || json_height != m_raw_image.height) {
					if (on_error) {
						on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error: load configuration: configuration doesn't match current camera settings!", &client_id);
					}
					return;
				}
			}
			catch (const std::exception& e) {
				if (on_error) on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error: load configuration: failed to parse required fields: " + std::string(e.what()), &client_id);
				return;
			}

			// Поля паттерна
			if (UJsonCalibrationConfiguration::contains_pattern_fields(obj)) {
				try {
					m_pattern.width = json_number_cast<int>(obj.at(constants::JSON_PATTERN_WIDTH));
					m_pattern.height = json_number_cast<int>(obj.at(constants::JSON_PATTERN_HEIGHT));
					m_pattern.size = json_number_cast<double>(obj.at(constants::JSON_PATTERN_SIZE));
					m_pattern.recieved = true;
				}
				catch (const std::exception& e) {
					m_logger.warn("load configuration: failed to parse pattern fields: " + std::string(e.what()));
				}
			}

			// Поля калибровки
			if (UJsonCalibrationConfiguration::contains_calibration_fields(obj)) {
				try {
					m_custom_parameters.alpha = json_number_cast<double>(obj.at(constants::META_ALPHA));
					m_custom_parameters.zoom = json_number_cast<double>(obj.at(constants::META_ZOOM));
					m_custom_parameters.shift_x = json_number_cast<double>(obj.at(constants::META_SHIFT_X));
					m_custom_parameters.shift_y = json_number_cast<double>(obj.at(constants::META_SHIFT_Y));

					m_calibration.rms = json_number_cast<double>(obj.at(constants::META_RMS));
					m_calibration.camera_matrix = SBinary::json_object_to_mat(obj.at(constants::JSON_CAMERA_MATRIX).as_object());
					m_calibration.distortion_coeffs = SBinary::json_object_to_mat(obj.at(constants::JSON_DISTORTION_COEFFS).as_object());

					if (m_calibration.camera_matrix.empty() || m_calibration.distortion_coeffs.empty()) {
						throw std::runtime_error("camera_matrix or distortion_coeffs is empty after parsing");
					}

					m_calibration.ready = true;
				}
				catch (const std::exception& e) {
					m_logger.warn("load configuration: failed to parse calibration fields: " + std::string(e.what()));
				}
			}

			// Поля undistortion
			if (UJsonCalibrationConfiguration::contains_undistortion_fields(obj)) {
				try {
					m_undistort.custom_camera_matrix = SBinary::json_object_to_mat(obj.at(constants::JSON_NEW_K).as_object());

					if (m_undistort.custom_camera_matrix.empty()) {
						throw std::runtime_error("new_k matrix is empty after parsing");
					}

					const auto filename_map_x = std::string(obj.at(constants::JSON_UNDISTORTION_MAP_X).as_string());
					const auto filename_map_y = std::string(obj.at(constants::JSON_UNDISTORTION_MAP_Y).as_string());

					const std::filesystem::path path_to_map_x = std::filesystem::path(constants::CALIBRATION_MAPS_PATH) / filename_map_x;
					const std::filesystem::path path_to_map_y = std::filesystem::path(constants::CALIBRATION_MAPS_PATH) / filename_map_y;

					if (!SBinary::load_mat_from_binary(path_to_map_x, m_undistort.matrix_x, &m_logger)) {
						throw std::runtime_error("failed to load map_x from: " + filename_map_x);
					}
					if (!SBinary::load_mat_from_binary(path_to_map_y, m_undistort.matrix_y, &m_logger)) {
						throw std::runtime_error("failed to load map_y from: " + filename_map_y);
					}

					m_undistort.ready = true;
				}
				catch (const std::exception& e) {
					m_logger.warn("load configuration: failed to parse undistortion fields: " + std::string(e.what()));
				}
			}

			boost::json::object send_meta;
			send_meta[constants::META_CONFIGURATION_METHOD] = constants::METHOD_CONFIGURATION_LOAD;
			send_message(make_socket_message(constants::TYPE_CALIBRATION_CONFIGURATION, true, &client_id, &m_name, &send_meta));

			// Отправляем новый текущий статус камеры
			boost::json::object status_meta;
			status_meta = build_json_calibration();
			send_message(make_socket_message(constants::TYPE_STATUS, true, &client_id, &m_name, &status_meta));
			m_logger.info("on_signaling_message(): transported calibration status");
			return;
		}
		else {
			if (on_error) on_error(constants::TYPE_CALIBRATION_CONFIGURATION, "Error: unresolved method at configuration request!", &client_id);
			return;
		}
	}

	void UCalibrator::apply_undistort_maps(const cv::Mat& src, cv::Mat& dst) {
		auto start = std::chrono::high_resolution_clock::now();

		if (!m_undistort.ready) {
			m_logger.trace("apply_undistort_maps(): cannot apply undistort, didn't compute maps");
			return;
		}

		if (m_undistort.matrix_x.size() != src.size() || m_undistort.matrix_y.size() != src.size()) {
			std::ostringstream oss;
			oss << "apply_undistort_maps(): size mismatch\n\tsource: " << src.size() << "\n\tmatrix_x: "
				<< m_undistort.matrix_x.size() << "\n\tmatrix_y: " << m_undistort.matrix_y.size();
			m_logger.trace(oss.str());
			return;
		}

		if (dst.empty() || dst.size() != src.size() || dst.type() != src.type()) {
			dst.create(src.size(), src.type());
		}

		cv::remap(src, dst, m_undistort.matrix_x, m_undistort.matrix_y, cv::INTER_CUBIC, cv::BORDER_CONSTANT);

		auto end = std::chrono::high_resolution_clock::now();
		double ms = std::chrono::duration_cast<std::chrono::microseconds>(end - start).count() / 1000.0;
		std::ostringstream oss;
		oss << "apply_undistort_maps(): successfulle remap image with size " << src.size() << " at " << ms;
		//m_logger.trace(oss.str());
	}

	void UCalibrator::find_and_draw_cornerns(cv::Mat& image) {
		if (image.empty()) {
			m_logger.trace("find_and_draw_cornerns(): input image is empty");
			return;
		}

		if (!m_pattern.recieved) {
			m_logger.trace((std::ostringstream() 
				<< "find_and_draw_cornerns(): skip corners chessboard=" << (m_to_show_chessboard ? "true" : "false") 
				<< ", pattern_received=" << (m_pattern.recieved ? "true" : "false")).str()
			);
			return;
		}

		if (image.depth() != CV_8U) {
			m_logger.error((std::ostringstream()
				<< "find_and_draw_cornerns(): unsupported depth=" << image.depth()
				<< " (expected CV_8U)").str()
			);
			return;
		}

		cv::Mat gray;
		try {
			switch (image.channels()) {
			case 1:
				gray = image;
				break;

			case 3:
				cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
				break;

			case 4:
				cv::cvtColor(image, gray, cv::COLOR_BGRA2GRAY);
				break;

			default:
				m_logger.error((std::ostringstream()
					<< "find_and_draw_cornerns(): unsupported channels=" << image.channels()).str()
				);
				return;
			}

			std::vector<cv::Point2f> corners;

			bool found = cv::findChessboardCorners(gray, cv::Size(m_pattern.width, m_pattern.height), corners, cv::CALIB_CB_FAST_CHECK);

			if (found) {
				cv::cornerSubPix(gray, corners, cv::Size(11, 11), cv::Size(-1, -1),
					cv::TermCriteria(cv::TermCriteria::EPS + cv::TermCriteria::MAX_ITER, 30, 0.1)
				);

				cv::drawChessboardCorners(image, cv::Size(m_pattern.width, m_pattern.height), corners, true);
			}
			else {
				//m_logger.trace("find_and_draw_cornerns(): chessboard not found");
			}

		}
		catch (const cv::Exception& e) {
			m_logger.error((std::ostringstream()
				<< "find_and_draw_cornerns(): OpenCV exception: " << e.what()).str()
			);
		}
	}

	boost::json::object UCalibrator::get_coeffs() {
		if (!m_calibration.ready) {
			return {};
		}

		try {
			boost::json::object result;
			result[constants::META_ALPHA] = m_custom_parameters.alpha;
			result[constants::META_ZOOM] = m_custom_parameters.zoom;
			result[constants::META_SHIFT_X] = m_custom_parameters.shift_x;
			result[constants::META_SHIFT_Y] = m_custom_parameters.shift_y;
			// K коэффициенты
			result[constants::META_K1] = m_calibration.distortion_coeffs.at<double>(0, 0);
			result[constants::META_K2] = m_calibration.distortion_coeffs.at<double>(1, 0);
			result[constants::META_K3] = m_calibration.distortion_coeffs.at<double>(2, 0);
			result[constants::META_K4] = m_calibration.distortion_coeffs.at<double>(3, 0);

			return result;
		}
		catch (...) {
			return {};
		}
	}

	boost::json::object UCalibrator::build_json_calibration() {
		boost::json::object result;

		result[constants::META_WIDTH] = m_raw_image.width;
		result[constants::META_HEIGHT] = m_raw_image.height;

		result[constants::JSON_IS_PATTERN] = m_pattern.recieved;
		result[constants::JSON_IS_CALIBRATION] = m_calibration.ready;
		result[constants::JSON_IS_UNDISTORTION] = m_undistort.ready;

		if (m_pattern.recieved) {
			result[constants::JSON_PATTERN_WIDTH] = m_pattern.width;
			result[constants::JSON_PATTERN_HEIGHT] = m_pattern.height;
			result[constants::JSON_PATTERN_SIZE] = m_pattern.size;
		}

		if (m_calibration.ready) {
			// Кастомные поля
			result[constants::META_ALPHA] = m_custom_parameters.alpha;
			result[constants::META_ZOOM] = m_custom_parameters.zoom;
			result[constants::META_SHIFT_X] = m_custom_parameters.shift_x;
			result[constants::META_SHIFT_Y] = m_custom_parameters.shift_y;
			// Значения K
			result[constants::META_K1] = m_calibration.distortion_coeffs.at<double>(0, 0);
			result[constants::META_K2] = m_calibration.distortion_coeffs.at<double>(1, 0);
			result[constants::META_K3] = m_calibration.distortion_coeffs.at<double>(2, 0);
			result[constants::META_K4] = m_calibration.distortion_coeffs.at<double>(3, 0);
		}

		result[constants::META_SHOW_CHESSBOARD] = m_to_show_chessboard;
		result[constants::META_SHOW_UNDISTORTION] = m_apply_undistort;
		return result;
	}

	// Хелпер
	const boost::json::object* UCalibrator::get_object_field(
		const boost::json::object& obj,
		const char* key,
		std::function<void(const std::string&)> on_error)
	{
		if (auto* v = obj.if_contains(key); v && v->is_object()) {
			return &v->as_object();
		}

		on_error(std::string("Missing or invalid field: ") + key);
		return nullptr;
	}

	const std::string UCalibrator::get_string_field(
		const boost::json::object& obj,
		const char* key,
		std::function<void(const std::string&)> on_error)
	{
		if (auto* v = obj.if_contains(key); v && v->is_string()) {
			return v->as_string().c_str();
		}

		on_error(std::string("Missing or invalid field: ") + key);
		return nullptr;
	}

	void UCalibrator::resize_keep_aspect(const FSizeImage& original, FSizeImage& source, int max_width, int max_height)
	{
		if (original.width == 0 || original.height == 0) {
			return;
		}

		double scale_w = static_cast<double>(max_width) / original.width;
		double scale_h = static_cast<double>(max_height) / original.height;
		double scale = std::min(scale_w, scale_h);

		source.width = static_cast<int>(original.width * scale);
		source.height = static_cast<int>(original.height * scale);
	}

	void UCalibrator::build_fisheye_dewarp_LUT(const std::string& client_id, int width, int height, float fov_deg) {
		if (!m_undistort.matrix_x.empty()) m_undistort.matrix_x.release();
		if (!m_undistort.matrix_y.empty()) m_undistort.matrix_y.release();

		m_undistort.matrix_x.create(height, width, CV_32F);
		m_undistort.matrix_y.create(height, width, CV_32F);

		float cx = width * 0.5f;
		float cy = height * 0.5f;

		float fov = fov_deg * CV_PI / 180.0f;

		// условный "фокус" под FOV
		float f = width / fov;

		for (int y = 0; y < height; y++) {
			for (int x = 0; x < width; x++) {

				float nx = (x - cx);
				float ny = (y - cy);

				float r = sqrt(nx * nx + ny * ny);

				if (r < 1e-6f) {
					m_undistort.matrix_x.at<float>(y, x) = cx;
					m_undistort.matrix_y.at<float>(y, x) = cy;
					continue;
				}

				// fisheye angle approximation
				float theta = r / f;

				// rectilinear projection
				float scale = tan(theta) / r;

				float src_x = cx + nx * scale;
				float src_y = cy + ny * scale;

				m_undistort.matrix_x.at<float>(y, x) = src_x;
				m_undistort.matrix_y.at<float>(y, x) = src_y;
			}
		}
		m_undistort.ready = true;
		send_message(make_socket_message(constants::TYPE_UNDISTORT_COMPUTE, true, &client_id, &m_name));
	}
} // calibration
} // varan