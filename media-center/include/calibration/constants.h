#pragma once

#include <string>

namespace varan {
namespace calibration {
namespace constants {

	inline const std::string calibration_url_server = "/calibrator/server"; // /calibrator/server
	inline const std::string CALIBRATION_STREAM_ID = "calibration_stream"; // calibration_stream

	// Тип подключений
	inline const std::string TYPE_CONNECTION = "connection";             // connection
	inline const std::string TYPE_CLOSE = "close";                       // close
	inline const std::string TYPE_CHESSBOARD = "chessboard";             // chessboard
	inline const std::string TYPE_SET_PATTERN = "calibrate_pattern";     // calibrate_pattern
	inline const std::string TYPE_ADD_IMAGE = "add_image";               // add_image
	inline const std::string TYPE_DELETE_IMAGE = "delete_image";         // delete_image
	inline const std::string TYPE_GET_IMAGE = "get_image";               // get_image
	inline const std::string TYPE_LAUNCH = "launch";                     // launch
	inline const std::string TYPE_STATUS = "status";                     // status

	inline const std::string TYPE_GET_PATTERN = "get_pattern";             // get_pattern
	inline const std::string TYPE_GET_DISTOTION = "get_distortion";        // get_distortion

	inline const std::string TYPE_CALIBRATION_START = "calibration_start";        // calibration_start
	inline const std::string TYPE_CALIBRATION_PROGRESS = "calibration_progress";  // calibration_progress
	inline const std::string TYPE_CALIBRATION_COMPUTE = "calibration_compute";    // calibration_compute
	inline const std::string TYPE_CALIBRATION_RESULT = "calibration_result";      // calibration_result

	inline const std::string TYPE_UNDISTORT_COMPUTE = "undistort_compute";     // undistort_compute
	inline const std::string TYPE_GET_UNDISTORT_PARAMETERS = "get_undistort_parameters";  // get_undistort_parameters
	inline const std::string TYPE_VIEW_UNDISTORT = "view_undistort";           // view_undistort

	inline const std::string TYPE_MESSAGE = "message";                   // message

	// Переменные в meta
	inline const std::string META_ID_STREAM = "id_stream"; // id_stream
	inline const std::string META_STATUS = "status"; // status

	inline const std::string META_SHOW_CHESSBOARD = "show"; // show

	inline const std::string META_ADDED_ID = "added_id"; // added_id
	inline const std::string META_COUNT = "count"; // count

	inline const std::string META_CURRENT_COUNT = "current_count"; // current_count
	inline const std::string META_TOTAL = "total"; // total
	inline const std::string META_CORNERS_FOUND = "corners_found"; // corners_found
	inline const std::string META_USED_IMAGES = "used_images"; // used_images

	inline const std::string META_ID = "id"; // id
	inline const std::string META_DELETE_ALL = "all"; // all

	inline const std::string META_PATTERN = "pattern"; // pattern
	inline const std::string META_PATTERN_WIDTH = "width"; // width
	inline const std::string META_PATTERN_HEIGHT = "height"; // height
	inline const std::string META_PATTERN_SIZE = "size"; // size

	inline const std::string META_DISTORTION = "distortion"; // distortion
	inline const std::string META_RMS = "rms"; // rms
	inline const std::string META_CAMERA_MATRIX = "camera_matrix"; // camera_matrix
	inline const std::string META_DISTORION_COEFFS = "distortion_coeffs"; // distortion_coeffs

	inline const std::string META_ALPHA = "alpha";        // alpha
	inline const std::string META_ZOOM = "zoom";          // zoom
	inline const std::string META_SHIFT_X = "shift_x";    // shift_x
	inline const std::string META_SHIFT_Y = "shift_y";    // shift_y

	inline const std::string META_MAT_ROWS = "rows";
	inline const std::string META_MAT_COLS = "cols";
	inline const std::string META_MAT_TYPE = "type";
	inline const std::string META_MAT_DATA = "data";

} // constants 
} // calibration
} // varan