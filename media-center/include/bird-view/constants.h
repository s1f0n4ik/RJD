#pragma once

#include <string>
#include <filesystem>

#include "calibration/constants.h"

namespace varan {
namespace birdview {
namespace constants {

	// Подставляется, когда в состоянии конфигурации нет своего stream_id
	inline const std::string VIRTUAL_CAMERA_ID = "birdview_linker";

	const std::string CAMERA_FRONT = "front";
	const std::string CAMERA_RIGHT = "right";
	const std::string CAMERA_RIGHT_FRONT = "right_front";
	const std::string CAMERA_RIGHT_BACK = "right_back";
	const std::string CAMERA_BACK = "back";
	const std::string CAMERA_LEFT = "left";
	const std::string CAMERA_LEFT_BACK = "left_back";
	const std::string CAMERA_LEFT_FRONT = "left_front";

	constexpr int SIX_BIRDVIEW_CAMERA_NUM = 6;

	constexpr int SIX_BIRDVIEW_CAMERA_FRONT_ID = 0;
	constexpr int SIX_BIRDVIEW_CAMERA_RIGHT_FRONT_ID = 1;
	constexpr int SIX_BIRDVIEW_CAMERA_RIGHT_BACK_ID = 2;
	constexpr int SIX_BIRDVIEW_CAMERA_BACK_ID = 3;
	constexpr int SIX_BIRDVIEW_CAMERA_LEFT_BACK_ID = 4;
	constexpr int SIX_BIRDVIEW_CAMERA_LEFT_FRONT_ID = 5;

	constexpr int FOUR_BIRDVIEW_CAMERA_NUM = 4;

	constexpr int FOUR_BIRDVIEW_CAMERA_FRONT_ID = 0;
	constexpr int FOUR_BIRDVIEW_CAMERA_RIGHT_ID = 1;
	constexpr int FOUR_BIRDVIEW_CAMERA_BACK_ID = 2;
	constexpr int FOUR_BIRDVIEW_CAMERA_LEFT_ID = 3;

	inline const std::filesystem::path cube_vsh = "shaders/cube.vert";                 // "shaders/cube.vert"
	inline const std::filesystem::path cube_fsh = "shaders/cube.frag";                 // "shaders/cube.frag"

	inline const std::filesystem::path stitching_vsh = "shaders/stitch.vert";          // "shaders/stitch.vert"
	inline const std::filesystem::path stitching_fsh = "shaders/stitch.frag";          // "shaders/stitch.frag"
	inline const std::filesystem::path normalize_fsh = "shaders/normalize.frag";       // "shaders/normalize.frag"
	inline const std::filesystem::path overlay_fsh = "shaders/overlay.frag";       // "shaders/normalize.frag"
	inline const std::filesystem::path overlay_vsh = "shaders/overlay.vert";       // "shaders/normalize.frag"

	inline const std::filesystem::path surround_vsh = "shaders/surround.vert";     // "shaders/surround.vert"
	inline const std::filesystem::path surround_fsh = "shaders/surround.frag";     // "shaders/surround.frag"
	inline const std::filesystem::path surround_norm_fsh = "shaders/surround-normalize.frag"; // "shaders/surround-normalize.frag"
	inline const std::filesystem::path surround_probe_vsh = "shaders/surround-probe.vert";   // "shaders/surround-probe.vert"
	inline const std::filesystem::path surround_probe_fsh = "shaders/surround-probe.frag";   // "shaders/surround-probe.frag"

	// Размер кадра объёмного вида: 16:9, стороны кратны 16 для кодека
	inline constexpr int SURROUND_WIDTH = 1280;
	inline constexpr int SURROUND_HEIGHT = 720;

	// Пресеты конфигуратора и их картинки. Раньше эти пути были продублированы
	// здесь строкой — два имени на один файл расходились при любой правке
	inline const std::filesystem::path LINKER_CONFIGURATIONS = calibration::constants::PROJECTION_CONFIGURES_PATH;
	inline const std::filesystem::path LINKER_IMAGES_PATH    = calibration::constants::PROJECTION_IMAGES_PATH;
	 
	inline const std::filesystem::path current_shader_path(const std::filesystem::path& shader) {
		return std::filesystem::current_path() / shader;
	}

}; // constants
}; // birdview
}; // varan