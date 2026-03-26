#pragma once

#include <string>
#include <filesystem>

namespace varan {
namespace birdview {
namespace constants {

	const std::string CAMERA_FRONT = "front";
	const std::string CAMERA_RIGHT_FRONT = "right_front";
	const std::string CAMERA_RIGHT_BACK = "right_back";
	const std::string CAMERA_BACK = "back";
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

	const std::filesystem::path cube_vsh = "shaders/cube.vert";
	const std::filesystem::path cube_fsh = "shaders/cube.frag";

	inline const std::filesystem::path current_shader_path(const std::filesystem::path& shader) {
		return std::filesystem::current_path() / shader;
	}

}; // constants
}; // birdview
}; // varan