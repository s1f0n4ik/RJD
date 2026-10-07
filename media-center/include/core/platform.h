#pragma once

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <string>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <cstdlib>
#include <system_error>
#include <vector>

namespace varan {

	// Устройство: вычислительная площадка, идентификатор, сессия запуска.
	//   platform: rk3566 | rk3588 | nvidia | unknown
	//   npu_cores: только для показа и режима pinned; число слотов не ограничивает
	struct FDeviceInfo {
		std::string platform = "unknown";
		std::string label = "Unknown";
		int npu_cores = 0;
		// machine-id и MAC первого физического интерфейса
		std::string device_id = "unknown";
		// Время запуска media-center, unix мс
		std::int64_t session_id = 0;
	};

	namespace detail {

		// Первое слово файла; пусто — файла нет
		inline std::string read_token(const std::filesystem::path& path) {
			std::ifstream file(path);
			std::string token;
			file >> token;
			return token;
		}

		// MAC первого физического интерфейса без двоеточий
		inline std::string first_physical_mac() {
			namespace fs = std::filesystem;
			const fs::path net_root = "/sys/class/net";

			std::vector<std::string> names;
			std::error_code ec;
			for (const auto& entry : fs::directory_iterator(net_root, ec)) {
				names.push_back(entry.path().filename().string());
			}
			std::sort(names.begin(), names.end());

			auto mac_of = [&](const std::string& name) -> std::string {
				std::string mac = read_token(net_root / name / "address");
				mac.erase(std::remove(mac.begin(), mac.end(), ':'), mac.end());
				if (mac.empty() || mac == std::string(mac.size(), '0')) return {};
				return mac;
			};

			for (const auto& name : names) {
				if (name == "lo") continue;
				if (!fs::exists(net_root / name / "device", ec)) continue;
				auto mac = mac_of(name);
				if (!mac.empty()) return mac;
			}

			// Физических не нашлось (нестандартный sysfs) — берём любой не-loopback
			for (const auto& name : names) {
				if (name == "lo") continue;
				auto mac = mac_of(name);
				if (!mac.empty()) return mac;
			}

			return {};
		}

		// machine-id клонированных образов одинаковый — примешиваем MAC платы
		inline std::string read_device_id() {
			std::string id = read_token("/etc/machine-id");
			if (id.empty()) id = read_token("/var/lib/dbus/machine-id");

			const std::string mac = first_physical_mac();
			if (id.empty()) return mac.empty() ? "unknown" : mac;
			return mac.empty() ? id : id + "-" + mac;
		}

	} // detail

	// Площадка по VARAN_PLATFORM и device-tree; device_id и session_id не заполняет
	inline FDeviceInfo detect_platform() {
		// Явное переопределение для стендов/разработки.
		if (const char* env = std::getenv("VARAN_PLATFORM")) {
			std::string p = env;
			if (p == "rk3566") return { "rk3566", "RK3566", 1 };
			if (p == "rk3588") return { "rk3588", "RK3588", 3 };
			if (p == "nvidia") return { "nvidia", "NVIDIA", 0 };
		}

		// Строка совместимости из device-tree (null-разделённый список).
		std::string compat;
		for (const char* path : { "/proc/device-tree/compatible",
								  "/sys/firmware/devicetree/base/compatible" }) {
			std::ifstream f(path, std::ios::binary);
			if (f) { std::stringstream ss; ss << f.rdbuf(); compat = ss.str(); break; }
		}
		auto has = [&](const char* s) { return compat.find(s) != std::string::npos; };

		if (has("rk3588")) return { "rk3588", "RK3588", 3 };
		if (has("rk3566")) return { "rk3566", "RK3566", 1 };
		if (has("nvidia") || has("tegra")) return { "nvidia", "NVIDIA", 0 };

		std::error_code ec;
		if (std::filesystem::exists("/etc/nv_tegra_release", ec))
			return { "nvidia", "NVIDIA", 0 };

		return { "unknown", "Unknown", 0 };
	}

	// Определение устройства. Вызывается один раз в main, дальше значение
	// передаётся в UNeuralLoader — так логику нейронки можно будет менять
	// в зависимости от площадки.
	inline FDeviceInfo detect_device() {
		FDeviceInfo device = detect_platform();
		device.device_id = detail::read_device_id();
		device.session_id = std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::system_clock::now().time_since_epoch()).count();
		return device;
	}

} // namespace varan