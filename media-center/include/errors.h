#include "console_utility.h"
#include <iostream>
#include <string>

namespace varan {
namespace neural {

std::string vn_error(int ret) {
	switch (ret) {
	// Ошибка существовании камеры
	case -1:
		std::ostringstream oss;
		oss << color::red << "Camera";
		return oss.str();
	}
}

} // neural
} // varan