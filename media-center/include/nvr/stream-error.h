#pragma once

#include <algorithm>
#include <cctype>
#include <string>

#include "signaling_definers.h"

namespace varan {
namespace nvr {

	// Числовой код ошибки потока по тексту ошибки rtspsrc.
	// Порядок важен: «host not found» — это адрес, а не поток, поэтому недоступность разбирается до «not found»
	// debug — строка отладки GStreamer: первая строка в ней место в исходниках («file.c(9088): func (): /Pipeline/Element:»),
	// причина лежит в следующих. rtspsrc на отказ соединения даёт общее «Could not open resource…» и «Failed to connect.»
	// только в debug. Первую строку отбрасываем: номер строки исходника легко сойдёт за 401 или 404.
	inline int classify_stream_error(std::string message, const std::string& debug = "") {
		const auto newline = debug.find('\n');
		if (newline != std::string::npos) message += "\n" + debug.substr(newline + 1);

		std::transform(message.begin(), message.end(), message.begin(),
			[](unsigned char c) { return static_cast<char>(std::tolower(c)); });

		const auto has = [&](const char* part) { return message.find(part) != std::string::npos; };

		if (has("unauthorized") || has("forbidden") || has("401") || has("403")) {
			return signaling::CODE_RTSP_UNAUTHORIZED;
		}
		if (has("no route") || has("could not connect") || has("failed to connect")
			|| has("connection refused") || has("unreachable") || has("host not found")
			|| has("name or service not known") || has("name resolution")) {
			return signaling::CODE_RTSP_UNREACHABLE;
		}
		if (has("not found") || has("404")) {
			return signaling::CODE_RTSP_NOT_FOUND;
		}
		if (has("timeout") || has("timed out")) {
			return signaling::CODE_RTSP_TIMEOUT;
		}
		if (has("end-of-file") || has("received end") || has("could not receive message")) {
			return signaling::CODE_RTSP_DISCONNECTED;
		}
		return signaling::CODE_GST_ERROR;
	}

} // namespace nvr
} // namespace varan
