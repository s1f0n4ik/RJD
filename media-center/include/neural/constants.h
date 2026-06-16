#pragma once

#include <string>
#include <filesystem>

namespace varan {
namespace neural {
namespace constants {
		
	const inline std::filesystem::path CONFIG_PATH = "/home/orangepi/varan/neural/configurations.json";
	const inline std::filesystem::path STATE_PATH = "/home/orangepi/varan/neural/state.json";
	const inline std::filesystem::path MODEL_PATH = "/home/orangepi/varan/neural/models";

} // constants
} // neural
} // varan