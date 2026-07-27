#pragma once
#include <opencv2/core.hpp>
#include <boost/json.hpp>
#include <string>
#include <fstream>
#include <iostream>
#include <filesystem>

#include "logger.h"
#include "constants.h"

namespace varan {
namespace calibration {
namespace utility {

	struct FMainParameters {
		std::string display_name;
		std::string id;
		int width;
		int height;
	};

	struct FCalibratorPattern {
		int width;
		int height;
		float size;

		bool recieved = false;
	};

	struct FCameraMatrixParameters {
		float alpha;
		float zoom;
		float shift_x;
		float shift_y;
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

		bool ready = false;
	};

	// Привязка одной камеры в пресете склейки
	struct FProjectionCamera {
		std::string key;    // Ключ камеры
		std::string name;   // Отображаемое имя камеры

		// id физической камеры, чей кадр размечали; пишется вместе с точками
		std::string camera_id;
		// Ключ конфигурации калибровки, с которой размечали; пусто - без неё
		std::string calibration_key;

		std::vector<cv::Point2f> src_points;     // Координаты точек на изображении
		std::vector<cv::Point2f> dst_points;     // Координаты точек внутри roi канваса
		std::vector<cv::Point2f> canvas_region;
	};

	struct FOverlayImageInfo {
		std::string name;
		std::filesystem::path path;
		cv::Rect rect;  // x, y, width, height
	};

	// Полный пресет склейки
	struct FProjectionPreset {
		std::string key;      // ключ пресета в json (например, "default_stitching")
		std::string name;     // отображаемое имя

		cv::Size canvas_size{ 0, 0 };

		// Камеры, индексированные по ключу
		std::unordered_map<std::string, FProjectionCamera> cameras;

		std::vector<FOverlayImageInfo> images;
	};

	class SBinary {
	public:
		struct FHeader
		{
			uint32_t magic = 0x4D415431; // "MAT1"
			uint32_t rows = 0;
			uint32_t cols = 0;
			uint32_t type = 0;
			uint64_t dataSize = 0;
		};

		static bool save_mat_to_binary(const std::filesystem::path& path, const cv::Mat& mat, ULogger* logger = nullptr) {
			if (mat.empty()) {
				if (logger) logger->warn("SBinary save_mat_to_binary(): could not save matrix: empty!");
				return false;
			}
			std::filesystem::path fs_path(path);
			if (fs_path.has_parent_path()) {
				std::filesystem::create_directories(fs_path.parent_path());
			}

			std::ofstream ofs(path, std::ios::binary);
			if (!ofs) {
				if (logger) logger->warn("SBinary save_mat_to_binary(): failed to open file for writing: " + path.string());
				return false;
			}

			// Создание хедера для бинарника
			FHeader header;
			header.rows = static_cast<uint32_t>(mat.rows);
			header.cols = static_cast<uint32_t>(mat.cols);
			header.type = static_cast<uint32_t>(mat.type());
			header.dataSize = static_cast<uint64_t>(mat.total() * mat.elemSize());

			ofs.write(reinterpret_cast<const char*>(&header), sizeof(header));
			if (!ofs) {
				if (logger) logger->warn("SBinary save(): failed to write header: " + path.string());
				return false;
			}

			// Запись самого массива
			if (mat.isContinuous()) {
				ofs.write(reinterpret_cast<const char*>(mat.ptr()), static_cast<std::streamsize>(header.dataSize));
			}
			else {
				const size_t rowSize = static_cast<size_t>(mat.cols) * mat.elemSize();
				for (int r = 0; r < mat.rows; ++r) {
					ofs.write(reinterpret_cast<const char*>(mat.ptr(r)), static_cast<std::streamsize>(rowSize));
				}
			}

			if (!ofs) {
				if (logger) logger->warn("SBinary save(): failed to write matrix data: " + path.string());
				return false;
			}
			return true;
		};

		static bool load_mat_from_binary(const std::filesystem::path& path, cv::Mat& out, ULogger* logger) {
			if (!std::filesystem::exists(path)) {
				if (logger) logger->warn("SBinary load(): file doesn't exist: " + path.string());
				return false;
			}

			std::ifstream ifs(path, std::ios::binary);
			if (!ifs) {
				if (logger) logger->warn("SBinary load(): failed to open file for reading: " + path.string());
				return false;
			}

			// Считывание хедера
			FHeader header;
			ifs.read(reinterpret_cast<char*>(&header), sizeof(header));

			if (!ifs) {
				if (logger) logger->warn("SBinary load(): failed to read header: " + path.string());
				return false;
			}
			if (header.magic != 0x4D415431) {
				if (logger) logger->warn("SBinary load(): invalid binary mat file: " + path.string());
				return false;
			}

			// Считывание данных матрицы из хедера
			cv::Mat result(static_cast<int>(header.rows), static_cast<int>(header.cols), static_cast<int>(header.type));
			const size_t expectedSize = result.total() * result.elemSize();
			if (expectedSize != header.dataSize) {
				if (logger) logger->warn("SBinary load(): matrix size mismatch: " + path.string());
				return false;
			}

			// Считывание самой матрицы
			if (result.isContinuous()) {
				ifs.read(reinterpret_cast<char*>(result.ptr()), static_cast<std::streamsize>(header.dataSize));
			}
			else {
				const size_t rowSize = static_cast<size_t>(result.cols) * result.elemSize();
				for (int r = 0; r < result.rows; ++r) {
					ifs.read(reinterpret_cast<char*>(result.ptr(r)), static_cast<std::streamsize>(rowSize));
					if (!ifs) {
						if (logger) logger->warn("SBinary load(): failed to read matrix data while scanning rows: " + path.string());
						return false;
					}
				}
			}

			if (!ifs) {
				if (logger) logger->warn("SBinary load(): failed to read matrix data: " + path.string());
				return false;
			}

			// вывод
			out = result;
			return true;
		};

		static boost::json::object make_json_object_mat(const cv::Mat& input) {
			boost::json::object result;
			result[constants::META_MAT_ROWS] = input.rows;
			result[constants::META_MAT_COLS] = input.cols;
			result[constants::META_MAT_TYPE] = input.type();
			result[constants::META_MAT_DATA] = mat_to_flat_array(input);

			return result;
		};

		static boost::json::array mat_to_flat_array(const cv::Mat& mat) {
			if (mat.channels() != 1) {
				return boost::json::array();
			}
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
				fill.template operator() < double > ();
				break;
			case CV_32F:
				fill.template operator() < float > ();
				break;
			case CV_32S:
				fill.template operator() < int > ();
				break;
			case CV_8U:
				fill.template operator() <uint8_t> ();
				break;
			default:
				return boost::json::array();
			}

			return arr;
		};

		static cv::Mat json_object_to_mat(const boost::json::object& obj) {
			try {
				if (!obj.contains(constants::META_MAT_ROWS) ||
					!obj.contains(constants::META_MAT_COLS) ||
					!obj.contains(constants::META_MAT_TYPE) ||
					!obj.contains(constants::META_MAT_DATA))
				{
					throw std::runtime_error("missing required mat fields (rows/cols/type/data)");
				}

				const int rows = static_cast<int>(obj.at(constants::META_MAT_ROWS).as_int64());
				const int cols = static_cast<int>(obj.at(constants::META_MAT_COLS).as_int64());
				const int type = static_cast<int>(obj.at(constants::META_MAT_TYPE).as_int64());

				if (!obj.at(constants::META_MAT_DATA).is_array()) {
					throw std::runtime_error("mat data field is not an array");
				}
				const auto& arr = obj.at(constants::META_MAT_DATA).as_array();

				cv::Mat result = flat_array_to_mat(arr, rows, cols, type);
				if (result.empty()) {
					throw std::runtime_error("flat_array_to_mat returned empty mat");
				}

				return result;
			}
			catch (const std::exception& e) {
				// Логгер здесь недоступен — пробрасываем выше,
				// чтобы поймать в вызывающем контексте, где есть m_logger
				throw std::runtime_error("json_object_to_mat(): " + std::string(e.what()));
			}
		}

		static cv::Mat flat_array_to_mat(const boost::json::array& arr, int rows, int cols, int type) {
			if ((rows <= 0 || cols <= 0) || (static_cast<size_t>(rows * cols) != arr.size())) {
				return {};
			}

			cv::Mat mat(rows, cols, type);

			switch (type) {
			case CV_64F: {
				double* data = mat.ptr<double>(0);
				for (size_t i = 0; i < arr.size(); ++i) {
					data[i] = get_number(arr[i]);
				}
				break;
			}

			case CV_32F: {
				float* data = mat.ptr<float>(0);
				for (size_t i = 0; i < arr.size(); ++i)
					data[i] = static_cast<float>(get_number(arr[i]));
				break;
			}

			case CV_32S: {
				int* data = mat.ptr<int>(0);
				for (size_t i = 0; i < arr.size(); ++i)
					data[i] = static_cast<int>(get_number(arr[i]));
				break;
			}

			case CV_8U: {
				uint8_t* data = mat.ptr<uint8_t>(0);
				for (size_t i = 0; i < arr.size(); ++i)
					data[i] = static_cast<uint8_t>(get_number(arr[i]));
				break;
			}

			default:
				return {};
			}

			return mat;
		}

		static double get_number(const boost::json::value& v) {
			if (v.is_double()) return v.as_double();
			if (v.is_int64()) return static_cast<double>(v.as_int64());
			return 0.0;
		};
	};

	template<typename T>
	static inline T json_number_cast(const boost::json::value& v) {
		if (v.is_int64()) {
			return static_cast<T>(v.as_int64());
		}

		if (v.is_uint64()) {
			return static_cast<T>(v.as_uint64());
		}

		if (v.is_double()) {
			return static_cast<T>(v.as_double());
		}

		throw std::runtime_error("JSON value <" + boost::json::serialize(v) + "> is not numeric");
	}

}; // utility
}; // calibration
}; // varan