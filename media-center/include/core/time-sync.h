#pragma once

#include <chrono>
#include <mutex>

#include "gateway/frame.h"

namespace varan {
namespace time_sync {

	// Синхронизация времени, получаемая из message-gateway
	// Класс должен понимать, приходит еу валидное время или нет

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

// Флаг положительный, сервис взял время у Садко - достоверное
inline bool trusted() {
	auto& s = detail::state();
	std::lock_guard<std::mutex> lock(s.mutex);
	return s.synced && s.base.sadko_time;
}

inline std::int64_t mono_ms() {
	static const std::chrono::steady_clock::time_point started =
		std::chrono::steady_clock::now();
	return std::chrono::duration_cast<std::chrono::milliseconds>(
		std::chrono::steady_clock::now() - started).count();
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
