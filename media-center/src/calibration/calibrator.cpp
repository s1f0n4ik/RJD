#include "calibration/calibrator.h"
#include "calibration/constants.h"

#include "signaling_definers.h"

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
	{}

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
				int max_width = 1080;
				if (auto* v = meta->if_contains("max_width"); v && v->is_int64()) {
					max_width = v->as_int64();
				}
				int max_height = 1080;
				if (auto* v = meta->if_contains("max_height"); v && v->is_int64()) {
					max_height = v->as_int64();
				}
				resize_keep_aspect(m_raw_image, m_resized_image, max_width, max_height);
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
					send_meta[constants::META_SHOW_CHESSBOARD] = m_to_show_chessboard;
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
				send_meta[constants::META_PATTERN] = m_pattern.recieved;
				send_meta[constants::META_DISTORTION] = m_calibration.ready;
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
				send_meta[constants::META_CAMERA_MATRIX] = make_json_object_mat(m_calibration.camera_matrix);
				send_meta[constants::META_DISTORION_COEFFS] = make_json_object_mat(m_calibration.distortion_coeffs);

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
				
			}
			else {
				on_error(constants::TYPE_MESSAGE, "Error with message: unsupported type message!", &client_id);
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

		cv::Mat to_push;
		if (m_apply_undistort) {
			to_push.create(image.size(), image.type());
			apply_undistort_maps(image, to_push);
		}
		else {
			to_push = std::move(image);
		}

		// Првоеряем нужно ли делать resize
		if (m_resized_image != m_raw_image) {
			cv::resize(
				image,
				to_push,
				cv::Size(m_resized_image.width, m_resized_image.height),
				0, 0,
				cv::INTER_AREA
			);
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

		m_calibration_thread = std::thread([this, client_id]() {

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

					boost::json::object meta;
					meta[constants::META_CURRENT_COUNT] = i + 1;
					meta[constants::META_TOTAL] = total;
					meta[constants::META_ID] = i;
					meta[constants::META_CORNERS_FOUND] = false;

					send_message(make_socket_message(constants::TYPE_CALIBRATION_PROGRESS, true, &client_id, &m_name, &meta));
					continue;
				}

				std::vector<cv::Point2f> corners;
				bool found = cv::findChessboardCorners(gray, pattern_size, corners);
				bool chess_result = found && (corners.size() == pattern_size.area());
				// Отправляем прогресс
				{
					boost::json::object meta;
					meta[constants::META_CURRENT_COUNT] = i + 1;
					meta[constants::META_TOTAL] = total;
					meta[constants::META_ID] = i;
					meta[constants::META_CORNERS_FOUND] = chess_result;

					send_message(make_socket_message(constants::TYPE_CALIBRATION_PROGRESS, true, &client_id, &m_name, &meta));
				}

				if (!chess_result) {
					m_logger.warn("run_calibration(): corners not found on image " + std::to_string(i));
					continue;
				}

				cv::cornerSubPix(gray, corners, cv::Size(11, 11), cv::Size(-1, -1),
					cv::TermCriteria(cv::TermCriteria::EPS + cv::TermCriteria::MAX_ITER, 30, 0.1));

				object_points.push_back(single_object_points);
				image_points.push_back(corners);
			}

			if (image_points.size() < 3) {
				send_message(make_socket_error(constants::TYPE_CALIBRATION_RESULT,
					"Not enough images with detected corners (need at least 3)",
					&client_id, &m_name));
				return;
			}

			send_message(make_socket_message(constants::TYPE_CALIBRATION_COMPUTE, true, &client_id, &m_name));

			// Само вычисление
			cv::Mat camera_matrix, dist_coeffs;
			std::vector<cv::Mat> rvecs, tvecs;

			const cv::Size image_size(
				m_calibration_images[0].cols,
				m_calibration_images[0].rows
			);

			double rms = 0;
			try {
				rms = cv::fisheye::calibrate(
					object_points, image_points,
					image_size,
					camera_matrix, dist_coeffs,
					rvecs, tvecs,
					cv::fisheye::CALIB_RECOMPUTE_EXTRINSIC
				);
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
			meta[constants::META_RMS] = rms;
			meta[constants::META_USED_IMAGES] = static_cast<int>(image_points.size());
			meta[constants::META_TOTAL] = total;
			meta[constants::META_CAMERA_MATRIX] = make_json_object_mat(camera_matrix);
			meta[constants::META_DISTORION_COEFFS] = make_json_object_mat(dist_coeffs);

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
		send_meta[constants::META_ALPHA] = m_undistort.alpha;
		send_meta[constants::META_ZOOM] = m_undistort.ready ? m_undistort.custom_camera_matrix.at<double>(0, 0) / m_calibration.camera_matrix.at<double>(0, 0) 
			                                                : 1.0f;
		send_meta[constants::META_SHIFT_X] = m_undistort.ready ? m_undistort.custom_camera_matrix.at<double>(0, 2) 
			                                                   : m_calibration.camera_matrix.at<double>(0, 2);
		send_meta[constants::META_SHIFT_Y] = m_undistort.ready ? m_undistort.custom_camera_matrix.at<double>(1, 2) 
			                                                   : m_calibration.camera_matrix.at<double>(1, 2);

		send_message(make_socket_message(constants::TYPE_GET_UNDISTORT_PARAMETERS, true, &client_id, &m_name, &send_meta));
	}

	void UCalibrator::handle_undistort_computation(const std::string& client_id, const boost::json::object& meta, COnError on_error) {
		auto get_double_from_meta = [&](const boost::json::object& obj,
			const std::string& key,
			float& out,
			const char* field_name
		) -> bool
		{
			if (auto* v = obj.if_contains(key); v && v->is_double()) {
				out = static_cast<float>(v->as_double());
				return true;
			}

			if (on_error) {
				on_error(constants::TYPE_UNDISTORT_COMPUTE,
					std::string("Error with message: missing or invalid <") + field_name + "> at meta block!",
					&client_id);
			}
			return false;
		};

		float alpha = 0.0f;
		if (!get_double_from_meta(meta, constants::META_ID, alpha, "alpha")) return;

		float zoom = 1.0f;
		if (!get_double_from_meta(meta, constants::META_ZOOM, zoom, "zoom")) return;

		float shift_x = 1.0f;
		if (!get_double_from_meta(meta, constants::META_SHIFT_X, shift_x, "shift_x")) return;

		float shift_y = 1.0f;
		if (!get_double_from_meta(meta, constants::META_SHIFT_Y, shift_y, "shift_y")) return;

		compute_undistort_maps(client_id, alpha, true, zoom, shift_x, shift_y);
	}

	void UCalibrator::compute_undistort_maps(const std::string& client_id, float alpha, bool center, float zoom, float shift_x, float shift_y) {
		if (!m_calibration.ready) {
			send_message(make_socket_error(constants::TYPE_UNDISTORT_COMPUTE, "Cannot compute undistort maps: calibration didn't ready!", &client_id, &m_name));
			return;
		}

		auto ROI = cv::Rect(0, 0, m_raw_image.width, m_raw_image.height);
		auto image_size = cv::Size(m_raw_image.width, m_raw_image.height);
		// Вычисление новой матрицы K
		cv::Mat new_k = cv::getOptimalNewCameraMatrix(
			m_calibration.camera_matrix,
			m_calibration.distortion_coeffs,
			image_size,
			alpha,
			image_size,
			&ROI,
			true
		);
		// Кастомная настройка матрицы
		new_k.at<float>(0, 0) *= zoom;
		new_k.at<float>(1, 1) *= zoom;
		new_k.at<double>(0, 2) = shift_x;
		new_k.at<double>(1, 2) = shift_y;

		m_undistort.custom_camera_matrix = new_k;

		// Сама генерация
		cv::initUndistortRectifyMap(
			m_calibration.camera_matrix, 
			m_calibration.distortion_coeffs, 
			cv::Mat(), 
			m_undistort.custom_camera_matrix, 
			image_size, 
			CV_32FC1, 
			m_undistort.matrix_x, 
			m_undistort.matrix_y
		);
		send_message(make_socket_message(constants::TYPE_UNDISTORT_COMPUTE, true, &client_id, &m_name));
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

		cv::remap(src, dst, m_undistort.matrix_x, m_undistort.matrix_y, cv::INTER_LINEAR, cv::BORDER_CONSTANT);

		auto end = std::chrono::high_resolution_clock::now();
		double ms = std::chrono::duration_cast<std::chrono::microseconds>(end - start).count() / 1000.0;
		std::ostringstream oss;
		oss << "apply_undistort_maps(): successfulle remap image with size " << src.size() << " at " << ms;
		m_logger.trace(oss.str());
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
				m_logger.trace("find_and_draw_cornerns(): chessboard not found");
			}

		}
		catch (const cv::Exception& e) {
			m_logger.error((std::ostringstream()
				<< "find_and_draw_cornerns(): OpenCV exception: " << e.what()).str()
			);
		}
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

	boost::json::array mat_to_flat_array(const cv::Mat& mat) {
		CV_Assert(mat.channels() == 1);
		cv::Mat m = mat.isContinuous() ? mat : mat.clone();

		boost::json::array arr;
		arr.reserve(m.total());

		auto fill = [&]<typename T>() {
			const T* data = m.ptr<T>(0);
			for (size_t i = 0; i < m.total(); ++i)
				arr.emplace_back(data[i]);
		};

		switch (m.type()) {
			case CV_64F: 
				fill.template operator()<double> ();  
				break;
			case CV_32F: 
				fill.template operator()<float> ();   
				break;
			case CV_32S: 
				fill.template operator()<int> ();    
				break;
			case CV_8U:  
				fill.template operator()<uint8_t> (); 
				break;
			default: 
				return boost::json::array();
		}

		return arr;
	}

	boost::json::object UCalibrator::make_json_object_mat(const cv::Mat& input) {
		boost::json::object result;
		result[constants::META_MAT_ROWS] = input.rows;
		result[constants::META_MAT_COLS] = input.cols;
		result[constants::META_MAT_TYPE] = input.type();
		result[constants::META_MAT_DATA] = mat_to_flat_array(input);

		return result;
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
} // calibration
} // varan