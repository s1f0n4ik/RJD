#pragma once
#include <string>

namespace varan {
namespace nvr {
namespace constants {

	
	// Физических входов у многоматричных камер бывает до шести
	inline constexpr int MIN_CHANNEL = 1;
	inline constexpr int MAX_CHANNEL = 6;

	// Параллельных кодировщиков одной картинки вендоры дают не больше шести
	inline constexpr int MIN_SUBSTREAM = 1;
	inline constexpr int MAX_SUBSTREAM = 6;

};
};
};