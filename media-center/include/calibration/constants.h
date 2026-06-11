#pragma once

#include <string>
#include <array>

namespace varan {
namespace calibration {
namespace constants {

	inline const std::string calibration_url_server = "/calibrator/server"; // /calibrator/server
	inline const std::string CALIBRATION_STREAM_ID = "calibration_stream"; // calibration_stream

	inline const std::filesystem::path PROJECTION_CONFIGURES_PATH       = "/home/orangepi/varan/calibration/projection.json";         // "/home/orangepi/varan/calibration/projection.json"
	inline const std::string CALIBRATION_CONFIGURES_PATH                = "/home/orangepi/varan/calibration/configurations.json";     // "/home/orangepi/varan/calibration/configurations.json"
	inline const std::string CALIBRATION_MAPS_PATH                      = "/home/orangepi/varan/calibration/maps";                    // "/home/orangepi/varan/calibration/maps"

	inline const std::filesystem::path LINKER_CONFIGURES_ROOT = "/home/orangepi/varan/linker";           // "/home/orangepi/varan/linker"
	inline const std::filesystem::path LINKER_CONFIGURATION_INDEX = "stitching_exports.json";            // "stitching_exports.json"
	inline const std::filesystem::path LINKER_STATE_INDEX = "state.json";                                // "state.json"

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

	inline const std::string TYPE_COMPUTE_PANORAMA_REMAP = "compute_panorama_remap";     // compute_panorama_remap
	inline const std::string TYPE_PANORAMA_TOGGLE = "panorama_toggle";                   // panorama_toggle

	inline const std::string TYPE_CALIBRATION_START = "calibration_start";        // calibration_start
	inline const std::string TYPE_CALIBRATION_PROGRESS = "calibration_progress";  // calibration_progress
	inline const std::string TYPE_CALIBRATION_POST_PROCESS = "calibration_post_process";   // calibration_post_process
	inline const std::string TYPE_CALIBRATION_COMPUTE = "calibration_compute";    // calibration_compute
	inline const std::string TYPE_CALIBRATION_RESULT = "calibration_result";      // calibration_result
	inline const std::string TYPE_CALIBRATION_CONFIGURATION = "calibration_configuration";      // calibration_configuration

	inline const std::string TYPE_UNDISTORT_COMPUTE = "undistort_compute";     // undistort_compute
	inline const std::string TYPE_GET_UNDISTORT_PARAMETERS = "get_undistort_parameters";  // get_undistort_parameters
	inline const std::string TYPE_VIEW_UNDISTORT = "view_undistort";           // view_undistort

	inline const std::string TYPE_MESSAGE = "message";                   // message

	// Переменные в meta
	inline const std::string META_ID_STREAM = "id_stream";          // id_stream
	inline const std::string META_DISPLAY_NAME = "display_name";    // display_name
	inline const std::string META_STATUS = "status";                // status
	inline const std::string META_WIDTH = "width";                  // width
	inline const std::string META_HEIGHT = "height";                // height

	inline const std::string META_SHOW = "show";                               // show
	inline const std::string META_USE_PANORAMA_REMAP = "use_panorama_remap";   // use_panorama_remap
	inline const std::string META_SHOW_CHESSBOARD = "show_chessboard";         // show_chessboard
	inline const std::string META_SHOW_UNDISTORTION = "show_undistortion";     // show_undistortion

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

	inline const std::string META_DISTORTION = "distortion";                 // distortion
	inline const std::string META_RMS = "rms";                               // rms
	inline const std::string META_CAMERA_MATRIX = "camera_matrix";           // camera_matrix
	inline const std::string META_DISTORION_COEFFS = "distortion_coeffs";    // distortion_coeffs

	inline const std::string META_ALPHA = "alpha";        // alpha
	inline const std::string META_ZOOM = "zoom";          // zoom
	inline const std::string META_SHIFT_X = "shift_x";    // shift_x
	inline const std::string META_SHIFT_Y = "shift_y";    // shift_y

	inline const std::string META_K1 = "k1";              // k1
	inline const std::string META_K2 = "k2";              // k2
	inline const std::string META_K3 = "k3";              // k3
	inline const std::string META_K4 = "k4";              // k4

	inline const std::string META_MAT_ROWS = "rows";          // rows
	inline const std::string META_MAT_COLS = "cols";          // cols
	inline const std::string META_MAT_TYPE = "type";          // type
	inline const std::string META_MAT_DATA = "data";          // data

	inline const std::string META_CONFIGURATION_METHOD = "method";            // method
	inline const std::string META_CONFIGURATION_CONFIG_KEY = "config_key";    // config_key
	inline const std::string META_CONFIGURATION_CONFIG_ITEM = "config_item";  // config_item

	inline const std::string METHOD_CONFIGURATION_LOAD = "load";              // load
	inline const std::string METHOD_CONFIGURATION_SAVE = "save";              // save
	inline const std::string METHOD_CONFIGURATION_GET_ITEM = "get_item";      // get_item
	inline const std::string METHOD_CONFIGURATION_GET_LIST = "get_list";      // get_list

	inline const std::string META_CAMERA_BASE_CONFIGS = "configs";            // configs

	// Поля в блоке дисторсии
	inline const std::string JSON_CONFIG_KEY = "config_key";              // config_key
	inline const std::string JSON_ID = "id";                              // id
	inline const std::string JSON_DISPLAY_NAME = "display_name";          // display_name
	inline const std::string JSON_WIDTH = "width";                        // width
	inline const std::string JSON_HEIGHT = "height";                      // height

	inline const std::string JSON_PATTERN_SIZE = "pattern_size";            // pattern_size
	inline const std::string JSON_PATTERN_WIDTH = "pattern_width";          // pattern_width
	inline const std::string JSON_PATTERN_HEIGHT = "pattern_height";        // pattern_height
	inline const std::string JSON_CAMERA_MATRIX = "camera_matrix";          // camera_matrix
	inline const std::string JSON_DISTORTION_COEFFS = "distortion_coeffs";  // distortion_coeffs

	inline const std::string JSON_RMS = "rms";                              // rms
	inline const std::string JSON_ALPHA = "alpha";                          // alpha
	inline const std::string JSON_ZOOM = "zoom";                            // zoom
	inline const std::string JSON_SHIFT_X = "shift_x";                      // shift_x
	inline const std::string JSON_SHIFT_Y = "shift_y";                      // shift_y

	inline const std::string JSON_NEW_K = "new_K";                        // new_k
	inline const std::string JSON_UNDISTORTION_MAP_X = "undist_map_x";    // undist_map_x
	inline const std::string JSON_UNDISTORTION_MAP_Y = "undist_map_y";    // undist_map_y

	inline const std::string JSON_WARP_MAP_X = "warp_map_x";              // warp_map_x
	inline const std::string JSON_WARP_MAP_Y = "warp_map_y";              // warp_map_y

	inline const std::string JSON_IS_PATTERN = "is_pattern";               // is_pattern
	inline const std::string JSON_IS_CALIBRATION = "is_calibration";       // is_calibration
	inline const std::string JSON_IS_UNDISTORTION = "is_undistortion";     // is_undistortion

	// Константы для Projection
	// ===== Единые ключи камер по их положению на ТС =====
	// Использовать ВЕЗДЕ, где упоминается положение камеры.
	inline const std::string CAMERA_FRONT = "front";                 // front
	inline const std::string CAMERA_RIGHT = "right";                 // right
	inline const std::string CAMERA_RIGHT_FRONT = "right_front";     // right_front
	inline const std::string CAMERA_RIGHT_BACK = "right_back";       // right_back
	inline const std::string CAMERA_BACK = "back";                   // back
	inline const std::string CAMERA_LEFT = "left";                   // left
	inline const std::string CAMERA_LEFT_BACK = "left_back";         // left_back
	inline const std::string CAMERA_LEFT_FRONT = "left_front";       // left_front

	inline const std::array<std::string, 8>& camera_position_keys() {
		static const std::array<std::string, 8> keys = {
			CAMERA_FRONT, CAMERA_RIGHT, CAMERA_RIGHT_FRONT, CAMERA_RIGHT_BACK,
			CAMERA_BACK, CAMERA_LEFT, CAMERA_LEFT_BACK,  CAMERA_LEFT_FRONT
		};
		return keys;
	}

	// ===== Ключи projection-конфига =====
	inline const std::string PROJ_NAME = "name";             // name
	inline const std::string PROJ_CANVAS = "canvas";         // canvas
	inline const std::string PROJ_CAMERAS = "cameras";       // cameras

	inline const std::string PROJ_CAM_KEY = "key";            // key
	inline const std::string PROJ_CAM_NAME = "name";          // name
	inline const std::string PROJ_CAM_UNDEFINED = "undefined";          // undefined
	inline const std::string PROJ_CONFIG_KEY = "config_key";  // config_key ссылка на калибровочную запись <id>_<w>_<h>
	inline const std::string PROJ_SRC_POINTS = "src_points";  // src_points
	inline const std::string PROJ_DST_POINTS = "dst_points";  // dst_points

	// Поля
	inline const std::string PROJ_X = "x";                // x
	inline const std::string PROJ_Y = "y";                // y
	inline const std::string PROJ_WIDTH = "width";        // width
	inline const std::string PROJ_HEIGHT = "height";      // height

	inline const std::string TYPE_PROJECTION_CONFIGURATION = "projection_configuration";          // projection_configuration

	inline const std::string METHOD_PROJECTION_GET_LIST = "get_list";             // get_list
	inline const std::string METHOD_PROJECTION_SET_PRESET = "set_preset";         // set_preset
	inline const std::string METHOD_PROJECTION_APPLY_WARP = "apply_warp";         // apply_warp
	inline const std::string METHOD_PROJECTION_SAVE_LUT = "save_lut";             // save_lut

	inline const  std::string META_PROJECTION_CONFIG_KEY = "config_key";         // config_key
	inline const  std::string META_PROJECTION_METHOD = "method";                 // method
	inline const  std::string META_PROJECTION_PRESETS = "presets";               // presets
	inline const  std::string META_PROJECTION_KEY = "key";                       // key
	inline const  std::string META_PROJECTION_NAME = "name";                     // name
	inline const  std::string META_PROJECTION_CANVAS = "canvas";                 // canvas
	inline const  std::string META_PROJECTION_CAMERAS = "cameras";               // cameras
	inline const  std::string META_PROJECTION_POINTS_COUNT = "points_count";     // points_count
	inline const  std::string META_PROJECTION_MAX_POINTS = "max_points";         // max_points
	inline const  std::string META_PROJECTION_SRC_POINTS = "src_points";         // src_points
	inline const  std::string META_PROJECTION_CAMERA_ID = "camera_id";           // camera_id
	inline const std::string META_PROJECTION_ID = "id";                          // id
	inline const std::string PROJ_CANVAS_REGION = "canvas_region";               // canvas_region

} // constants 
} // calibration
} // varan