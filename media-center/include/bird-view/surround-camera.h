#pragma once

#include <functional>

#include "camera.h"

namespace varan {
namespace birdview {

	// Виртуальная камера линкера: поверх WebRTC-сигналинга принимает
	// сообщения type=orbit и отдаёт их выводу через колбэки
	class USurroundCamera : public neural::UVirtualCamera {
	public:
		// true - ручной режим, false - автооблёт
		using COrbitModeCallback = std::function<void(bool manual)>;
		// Нормированные дельты жеста: доли канваса и шаг зума
		using COrbitDeltaCallback = std::function<void(float dx, float dy, float dzoom)>;

		explicit USurroundCamera(
			const std::string& id,
			const nvr::FWebSocketOptions& socket_options,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
		);

		// Ставятся до start_websocket_client: сокет зовёт их из своего потока
		void set_orbit_callbacks(COrbitModeCallback mode, COrbitDeltaCallback delta);

		void on_signaling_message(const std::string& msg) override;

	private:
		void handle_orbit(const boost::json::object& obj);

	private:
		COrbitModeCallback m_orbit_mode;
		COrbitDeltaCallback m_orbit_delta;
	};

} // birdview
} // varan
