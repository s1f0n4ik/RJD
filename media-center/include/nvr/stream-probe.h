#pragma once

#include <string>

#include "logger.h"

namespace varan {
namespace nvr {

	// Причина отказа пробы; уходит на фронт как есть и решает, что подсветить
	enum class EProbeReason {
		NONE = 0,
		AUTH = 1,
		UNREACHABLE = 2,
		NO_STREAM = 3,
		TIMEOUT = 4,
		DECODER = 5
	};

	inline std::string probe_reason_to_string(EProbeReason reason) {
		switch (reason) {
		case EProbeReason::AUTH:        return "auth";
		case EProbeReason::UNREACHABLE: return "unreachable";
		case EProbeReason::NO_STREAM:   return "no_stream";
		case EProbeReason::TIMEOUT:     return "timeout";
		case EProbeReason::DECODER:     return "decoder";
		default:                        return "";
		}
	}

	struct FStreamProbe {
		bool ok = false;

		EProbeReason reason = EProbeReason::NONE;
		std::string details;

		std::string codec;
		int width = 0;
		int height = 0;
		int fps = 0;
	};

	// Проверка потока по ссылке, получает все данные конкретного потока камеры  
	FStreamProbe probe_stream(const std::string& rtsp_url, int timeout_sec, ULogger* logger);

} // namespace nvr
} // namespace varan
