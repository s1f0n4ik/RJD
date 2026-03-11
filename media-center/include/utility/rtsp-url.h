#pragma once

#include <unordered_map>
#include <functional>
#include <iostream>
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

	const std::string production_naming(ERtspType production) {
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

	using CRtspUrlMaker = std::string(*)(const std::string&, const std::string&, const std::string&, const std::string&, int);

	const std::unordered_map<ERtspType, CRtspUrlMaker> rtsp_maker = {
		{ERtspType::NO_PRODUCER, 
		[](const std::string& ip, const std::string& port, const std::string& admin, const std::string& password, int stream) {
			std::stringstream ss;
			ss << "rtsp://" << ip << ":" << port << "/user=" << admin << "_password="
			   << password << "_channel=0_stream=" << stream << "&onvif=0.sdp?real_stream";
			return ss.str();
		}},
		{ERtspType::DAHUA,
		[](const std::string& ip, const std::string& port, const std::string& admin, const std::string& password, int stream) {
			std::stringstream ss;
			ss << "rtsp://" << admin << ":" << password << "@" << ip << ":" << port << "/cam/realmonitor?channel=1&subtype=" << stream;
			return ss.str();
		}},
		{ERtspType::HIKVISION,
		[](const std::string& ip, const std::string& port, const std::string& admin, const std::string& password, int stream) {
			std::stringstream ss;
			ss << "rtsp://" << admin << ":" << password << "@" << ip << ":" << port << "/ISAPI/Streaming/Channels/10" << stream;
			return ss.str();
		}},
		{ERtspType::ACE,
		[](const std::string& ip, const std::string& port, const std::string& admin, const std::string& password, int stream) {
			std::stringstream ss;
			ss << "rtsp://" << ip << ":" << port << "/user=" << admin << "_password="
			   << password << "_channel=0_stream=" << stream << "&onvif=0.sdp?real_stream";
			return ss.str();
		}},
	};
} // namespace varan rtsp://admin:VniiTest@192.168.1.16:554/ISAPI/Streaming/Channels/101
} // namespace nvr  