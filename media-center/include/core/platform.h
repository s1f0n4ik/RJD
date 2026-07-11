#pragma once

#include <string>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <cstdlib>
#include <system_error>

namespace varan {

	// Тип вычислительной площадки и лимиты на число потоков.
	//   platform: rk3566 | rk3588 | nvidia | unknown
	//   mode:     single (1 поток) | cores (по NPU-ядрам) | unlimited
	//   max_streams: -1 — без ограничений
	struct FPlatformInfo {
		std::string platform = "unknown";
		std::string label = "Unknown";
		int npu_cores = 0;
		int max_streams = -1;
		std::string mode = "unlimited";
	};

	// Определение площадки. Вызывается один раз в main, дальше значение
	// передаётся в UNeuralLoader — так логику нейронки можно будет менять
	// в зависимости от площадки.
	inline FPlatformInfo detect_platform() {
		// Явное переопределение для стендов/разработки.
		if (const char* env = std::getenv("VARAN_PLATFORM")) {
			std::string p = env;
			if (p == "rk3566") return { "rk3566", "RK3566", 1, 1, "single" };
			if (p == "rk3588") return { "rk3588", "RK3588", 3, 3, "cores" };
			if (p == "nvidia") return { "nvidia", "NVIDIA", 0, -1, "unlimited" };
		}

		// Строка совместимости из device-tree (null-разделённый список).
		std::string compat;
		for (const char* path : { "/proc/device-tree/compatible",
								  "/sys/firmware/devicetree/base/compatible" }) {
			std::ifstream f(path, std::ios::binary);
			if (f) { std::stringstream ss; ss << f.rdbuf(); compat = ss.str(); break; }
		}
		auto has = [&](const char* s) { return compat.find(s) != std::string::npos; };

		if (has("rk3588")) return { "rk3588", "RK3588", 3, 3, "cores" };
		if (has("rk3566")) return { "rk3566", "RK3566", 1, 1, "single" };
		if (has("nvidia") || has("tegra")) return { "nvidia", "NVIDIA", 0, -1, "unlimited" };

		std::error_code ec;
		if (std::filesystem::exists("/etc/nv_tegra_release", ec))
			return { "nvidia", "NVIDIA", 0, -1, "unlimited" };

		// Неизвестная площадка — не ограничиваем.
		return { "unknown", "Unknown", 0, -1, "unlimited" };
	}

} // namespace varan