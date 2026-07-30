#pragma once

#include <string>
#include <filesystem>

namespace varan {
namespace constants {

	const std::filesystem::path nv12_converter_vsh = "shaders/nv12-converter.vert";
	const std::filesystem::path nv12_converter_fsh = "shaders/nv12-converter.frag";

	// Коррекция дисторсии: та же плоскость, ремап по undist-картам
	const std::filesystem::path undist_fsh = "shaders/undist.frag";

} // constants
} // varan