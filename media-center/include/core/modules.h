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

		// Назначения чужих модулей сборка не обслуживает
		bool supports(nvr::EStreamPurpose purpose) const {
			switch (purpose) {
			case nvr::EStreamPurpose::BIRDVIEW:
				return birdview;
			case nvr::EStreamPurpose::NEURAL:
				return neural;
			case nvr::EStreamPurpose::VIEW:
			case nvr::EStreamPurpose::RECORD:
				return true;
			default:
				return false;
			}
		}

		// Первое назначение, которого сборка не тянет
		std::optional<nvr::EStreamPurpose> unsupported(const nvr::FStreamPurposes& purposes) const {
			if (purposes.neural && !neural)     return nvr::EStreamPurpose::NEURAL;
			if (purposes.birdview && !birdview) return nvr::EStreamPurpose::BIRDVIEW;
			return std::nullopt;
		}
	};

} // varan
