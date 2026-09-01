#include "bird-view/surround-camera.h"

#include <algorithm>

#include "signaling_definers.h"

namespace varan {
namespace birdview {

	USurroundCamera::USurroundCamera(
		const std::string& id,
		const nvr::FWebSocketOptions& socket_options,
		ULogger::ELoggerLevel level
	)
		: neural::UVirtualCamera(id, socket_options, level)
	{
	}

	void USurroundCamera::set_orbit_callbacks(COrbitModeCallback mode, COrbitDeltaCallback delta) {
		m_orbit_mode = std::move(mode);
		m_orbit_delta = std::move(delta);
	}

	void USurroundCamera::on_signaling_message(const std::string& msg) {
		// Перехватывается только orbit, остальное разбирает база
		try {
			auto parsed = boost::json::parse(msg);
			if (parsed.is_object()) {
				const auto& obj = parsed.as_object();
				if (auto* t = obj.if_contains("type"); t && t->is_string()
					&& std::string(t->as_string().c_str()) == "orbit") {
					handle_orbit(obj);
					return;
				}
			}
		}
		catch (...) {
			// Не json - пусть база отвечает своей ошибкой
		}
		UCamera::on_signaling_message(msg);
	}

	void USurroundCamera::handle_orbit(const boost::json::object& obj) {
		std::string client_id;
		if (auto* v = obj.if_contains("client_id"); v && v->is_string()) {
			client_id = v->as_string().c_str();
		}

		// Смена режима подтверждается ответом, дельты идут потоком без ответов
		if (auto* m = obj.if_contains("mode"); m && m->is_string()) {
			const std::string mode = m->as_string().c_str();
			if (mode != "manual" && mode != "auto") {
				send_message(boost::json::serialize(make_json_message(
					client_id, false, "orbit", "mode must be manual or auto",
					varan::signaling::CODE_ORBIT_REJECTED)));
				return;
			}
			if (!m_orbit_mode) {
				send_message(boost::json::serialize(make_json_message(
					client_id, false, "orbit", "output is not in surround mode",
					varan::signaling::CODE_ORBIT_NOT_RUNNING)));
				return;
			}
			m_orbit_mode(mode == "manual");
			send_message(boost::json::serialize(make_json_message(
				client_id, true, "orbit", "mode=" + mode)));
			return;
		}

		if (!m_orbit_delta) return;

		auto num = [&](const char* key) {
			if (auto* v = obj.if_contains(key); v && v->is_number()) {
				const double d = v->to_number<double>();
				// Дельта - доля канваса за жест, больше единицы не бывает
				return static_cast<float>(std::clamp(d, -1.0, 1.0));
			}
			return 0.0f;
		};

		const float dx = num("dx");
		const float dy = num("dy");
		const float dzoom = num("dzoom");
		if (dx != 0.0f || dy != 0.0f || dzoom != 0.0f) {
			m_orbit_delta(dx, dy, dzoom);
		}
	}

} // birdview
} // varan
