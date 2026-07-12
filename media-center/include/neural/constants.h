#pragma once

#include <string>
#include <filesystem>

namespace varan {
namespace neural {
namespace constants {
		
	constexpr int GATEWAY_DETECTION_FONT_HEIGHT = 30; // подпись класса на боксе
    constexpr int GATEWAY_OVERLAY_FONT_HEIGHT = 36;   // блок времени/GPS

	const inline std::filesystem::path CONFIG_PATH = "/home/orangepi/varan/neural/configurations.json";
	const inline std::filesystem::path STATE_PATH = "/home/orangepi/varan/neural/state.json";
	const inline std::filesystem::path MODEL_PATH = "/home/orangepi/varan/neural/models";

} // constants
} // neural
} // varan