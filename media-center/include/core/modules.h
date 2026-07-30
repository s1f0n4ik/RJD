#pragma once

#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "utility/data-structs.h"

namespace varan {

	// Набор опциональных модулей сборки. Ядро камер (NVR) — не модуль,
	// оно включено всегда.
	struct FModuleSet {
		bool birdview = false;
		bool neural = false;

		// Разбор значения --modules=birdview,neural. Пустая строка — чистый NVR.
		// Неизвестное имя модуля — ошибка конфигурации, возвращается nullopt.
		static std::optional<FModuleSet> parse(const std::string& csv) {
			FModuleSet result;
			std::istringstream ss(csv);
			std::string token;

			while (std::getline(ss, token, ',')) {
				if (token.empty()) continue;
				if (token == "birdview") result.birdview = true;
				else if (token == "neural") result.neural = true;
				else return std::nullopt;
			}

			return result;
		}

		// Имена включённых модулей — для лога и ручки /system/info.
		std::vector<std::string> names() const {
			std::vector<std::string> result;
			if (birdview) result.push_back("birdview");
			if (neural) result.push_back("neural");
			return result;
		}

		std::string to_string() const {
			std::string result;
			for (const auto& name : names()) {
				if (!result.empty()) result += ",";
				result += name;
			}
			return result.empty() ? "none" : result;
		}

		// Камеры чужих модулей сборка не обслуживает.
		bool supports(nvr::ECameraType type) const {
			switch (type) {
			case nvr::ECameraType::BIRDVIEW:
				return birdview;
			case nvr::ECameraType::NEURAL:
				return neural;
			case nvr::ECameraType::COUNT:
				return false;
			default:
				return true;
			}
		}
	};

} // varan
