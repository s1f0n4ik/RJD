#pragma once

#include <chrono>
#include <mutex>

#include "gateway/frame.h"

namespace varan {
namespace time_sync {

/*
	Единое время процесса. Кормится клиентом шлюза (GetTime раз в 10с):
	снимок запоминается вместе с монотонным моментом приёма, между опросами
	время дотягивается локально. Шлюз отдаёт unix_ms уже сдвинутым на
	настроенный пользователем пояс — потребители используют его как есть.

	Пока шлюз не ответил, now() отдаёт системные часы (valid=false у GPS) —
	процесс работает как раньше, просто без «действительного» времени.
*/

namespace detail {

	struct FState {
		std::mutex mutex;
		gateway::FGatewayTimeGps base;
		std::chrono::steady_clock::time_point base_at;
		bool synced = false;
	};

	inline FState& state() {
		static FState instance;
		return instance;
	}

} // detail

// Свежий снимок от клиента шлюза
inline void update(const gateway::FGatewayTimeGps& t) {
	auto& s = detail::state();
	std::lock_guard<std::mutex> lock(s.mutex);
	s.base = t;
	s.base_at = std::chrono::steady_clock::now();
	s.synced = true;
}

inline bool synced() {
	auto& s = detail::state();
	std::lock_guard<std::mutex> lock(s.mutex);
	return s.synced;
}

// Последний снимок времени+GPS, дотянутый монотонными часами
inline gateway::FGatewayTimeGps now() {
	auto& s = detail::state();
	std::lock_guard<std::mutex> lock(s.mutex);

	if (!s.synced) {
		gateway::FGatewayTimeGps t;
		t.unix_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::system_clock::now().time_since_epoch()).count();
		return t;
	}

	gateway::FGatewayTimeGps t = s.base;
	t.unix_ms += std::chrono::duration_cast<std::chrono::milliseconds>(
		std::chrono::steady_clock::now() - s.base_at).count();
	return t;
}

inline std::int64_t now_ms() {
	return now().unix_ms;
}

} // time_sync
} // varan
