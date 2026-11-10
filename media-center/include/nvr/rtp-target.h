#pragma once

#include <stdexcept>
#include <string>

#include <boost/json.hpp>

#include "utility/data-structs.h"

namespace varan {
namespace nvr {

	// Пустая строка — цель описана верно
	inline std::string check_rtp_target(const FRtpTarget& rtp) {
		if (rtp.host.empty()) return "rtp host is empty";
		if (rtp.port < 1 || rtp.port > 65535) return "rtp port is out of range 1...65535";
		if (rtp.width < 0 || rtp.height < 0) return "rtp frame size can't be negative";
		if (rtp.transcode && ((rtp.width > 0 && rtp.width < 96) || (rtp.height > 0 && rtp.height < 64))) {
			return "rtp frame is smaller than the encoder minimum 96x64";
		}
		if (rtp.bitrate < 0) return "rtp bitrate can't be negative";
		if (rtp.qp_max < 0 || rtp.qp_max > 51) return "rtp qp_max is out of range 0...51";
		return {};
	}

	inline boost::json::object rtp_to_json(const FRtpTarget& rtp) {
		return {
			{"host", rtp.host},
			{"port", rtp.port},
			{"mode", rtp.transcode ? "transcode" : "copy"},
			{"width", rtp.width},
			{"height", rtp.height},
			{"bitrate", rtp.bitrate},
			{"qp_max", rtp.qp_max}
		};
	}

	// Поля, которых нет в объекте, остаются по умолчанию; неверный тип бросает исключение
	inline FRtpTarget rtp_from_json(const boost::json::object& obj) {
		FRtpTarget rtp;

		if (const auto* host = obj.if_contains("host")) rtp.host = boost::json::value_to<std::string>(*host);
		if (const auto* port = obj.if_contains("port")) rtp.port = boost::json::value_to<int>(*port);
		if (const auto* width = obj.if_contains("width")) rtp.width = boost::json::value_to<int>(*width);
		if (const auto* height = obj.if_contains("height")) rtp.height = boost::json::value_to<int>(*height);
		if (const auto* bitrate = obj.if_contains("bitrate")) rtp.bitrate = boost::json::value_to<int>(*bitrate);
		if (const auto* qp_max = obj.if_contains("qp_max")) rtp.qp_max = boost::json::value_to<int>(*qp_max);

		if (const auto* mode = obj.if_contains("mode")) {
			const auto name = boost::json::value_to<std::string>(*mode);
			if (name != "copy" && name != "transcode") throw std::runtime_error("rtp mode must be copy or transcode");
			rtp.transcode = name == "transcode";
		}

		return rtp;
	}

} // nvr
} // varan
