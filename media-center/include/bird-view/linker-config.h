#pragma once

#include <boost/json.hpp>

#include <functional>
#include <map>
#include <span>
#include <string>

#include "bird-view/linker-store.h"

namespace varan::birdview {

	inline constexpr unsigned LINKER_CONFIG_VISUAL = 1;
	inline constexpr unsigned LINKER_CONFIG_GEOMETRY = 2;
	inline constexpr unsigned LINKER_CONFIG_ORBIT = 4;

	enum class EFieldKind {
		NumPositive,     // число строго больше нуля
		NumNonNegative,  // число, ноль допустим
		NumAny,          // любое число
		NumAlpha,        // число в [0..1]
		Flag,            // bool
		SourceName,      // имя файла модели, пустое снимает модель
	};

	struct FSurroundField {
		const char* group;   // nullptr — ключ верхнего уровня
		const char* key;
		EFieldKind kind;
		unsigned dirty;
	};


	std::span<const FSurroundField> surround_fields();
	std::span<const FSurroundField> top_fields();
	bool check_surround_field(const FSurroundField& rule, const boost::json::value& value, std::string& error);
	bool is_surround_group(const std::string& key);

	struct FLinkerConfigUpdate {
		bool restart = false;
		bool resume = false;
		std::map<std::string, unsigned> changes;
	};

	using CPrepareLinkerConfig = std::function<void(const FLinkerConfigUpdate&)>;
	using CApplyLinkerConfig = std::function<std::string(const FLinkerConfigUpdate&)>;

	class ULinkerConfig {
	public:
		ULinkerConfig(ULinkerStore& store, ULogger* logger,
			CPrepareLinkerConfig prepare, CApplyLinkerConfig apply);

		std::string apply(const boost::json::value& part, bool running);

	private:
		ULinkerStore& m_store;
		ULogger* m_logger;
		CPrepareLinkerConfig m_prepare;
		CApplyLinkerConfig m_apply;
	};

}
