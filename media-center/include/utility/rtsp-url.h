#pragma once

#include <unordered_map>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>

namespace varan {
namespace nvr {
	enum class ERtspType {
		NO_PRODUCER = 0,
		DAHUA = 1,
		HIKVISION = 2,
		ACE = 3,
		COUNT = 4
	};

	inline const std::string production_naming(ERtspType production) {
		switch (production) {
		case ERtspType::NO_PRODUCER:
			return "Noname production";
		case ERtspType::DAHUA:
			return "Dahua";
		case ERtspType::HIKVISION:
			return "Hikvision";
		case ERtspType::ACE:
			return "ACE";
		default:
			return "No production";
		}
	};

	using CRtspUrlMaker = std::string(*)(const std::string&, const std::string&, const std::string&, const std::string&, int, int);

	// channel — физический вход камеры, substream — качество; оба с единицы
	inline const std::unordered_map<ERtspType, CRtspUrlMaker> rtsp_maker = {
		{ERtspType::NO_PRODUCER,
		[](const std::string& ip, const std::string& port, const std::string& admin, const std::string& password, int channel, int substream) {
			std::stringstream ss;
			ss << "rtsp://" << ip << ":" << port << "/user=" << admin << "_password="
			   << password << "_channel=" << channel - 1 << "_stream=" << substream - 1 << "&onvif=0.sdp?real_stream";
			return ss.str();
		}},
		{ERtspType::DAHUA,
		[](const std::string& ip, const std::string& port, const std::string& admin, const std::string& password, int channel, int substream) {
			std::stringstream ss;
			ss << "rtsp://" << admin << ":" << password << "@" << ip << ":" << port
			   << "/cam/realmonitor?channel=" << channel << "&subtype=" << substream - 1;
			return ss.str();
		}},
		{ERtspType::HIKVISION,
		[](const std::string& ip, const std::string& port, const std::string& admin, const std::string& password, int channel, int substream) {
			// В ISAPI идентификатор потока — это канал×100 + субпоток
			std::stringstream ss;
			ss << "rtsp://" << admin << ":" << password << "@" << ip << ":" << port
			   << "/ISAPI/Streaming/Channels/" << channel * 100 + substream;
			return ss.str();
		}},
		{ERtspType::ACE,
		[](const std::string& ip, const std::string& port, const std::string& admin, const std::string& password, int channel, int substream) {
			std::stringstream ss;
			ss << "rtsp://" << ip << ":" << port << "/user=" << admin << "_password="
			   << password << "_channel=" << channel - 1 << "_stream=" << substream - 1 << "&onvif=0.sdp?real_stream";
			return ss.str();
		}},
	};
} // namespace nvr
} // namespace varan