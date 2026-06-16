#pragma once

#include <string>

namespace varan {
namespace rest {
namespace fields {

	inline const std::string SOCKET_IP_ADRESS = "socket_ip";  // "socket_ip"
	inline const std::string SOCKET_PORT = "socket_port";     // "socket_port"

	inline const std::string RESULT = "result";           // "result"

	inline const std::string MAIN_STREAM = "main";            // "main"
	inline const std::string SUB_STREAM = "sub";              // "sub"
	inline const std::string NEURAL_STREAM = "neural";        // "neural"
	inline const std::string BIRD_VIEW_STREAM = "bird-view";  // "bird-view"

	inline const std::string STREAMS = "streams"; // "streams"
	inline const std::string CAMERAS = "cameras"; // "cameras"
	inline const std::string FIELDS = "fields";         // "fields"

	// Поля внутри пайплайнов при использовании get
	inline const std::string TYPE = "type";           // "type"
	inline const std::string STATUS = "status";              // "status"
	inline const std::string WIDTH = "width";                // "width"
	inline const std::string HEIGHT = "height";              // "height"
	inline const std::string CODEC = "codec";                // "codec"
	inline const std::string FPS = "fps";                    // "fps"
	inline const std::string USE_UDP = "use_udp";            // "use_udp"
	inline const std::string RTSP_URL = "rtsp";              // "rtsp"
	inline const std::string LATENCY = "latency";            // "latency"
	inline const std::string TO_RECORD = "to_record";        // "to_record"
	inline const std::string RECORD_PATH = "record_path";    // "record_path"
	inline const std::string SEGMENT_LENGTH = "segment";     // "segment"
	inline const std::string RECONNECT = "reconnect";        // "reconnect"
	inline const std::string SUB = "sub";                    // "sub"

	inline const std::string IP_ADRESS = "ip_adress";        // "ip_adress"
	inline const std::string PORT = "port";                  // "port"
	inline const std::string USER = "user";                  // "user"
	inline const std::string PASSWORD = "password";          // "password"
	inline const std::string PRODUCTION = "production";      // "production"
	inline const std::string CAMERA_TYPE = "type";           // "type"

	// Общие поля
	inline const std::string DESCRIPTION = "description";    // "description"
	inline const std::string ID = "id";                      // "id"
	inline const std::string NAME = "name";                  // "description"
	inline const std::string DISPLAY_NAME = "display_name";  // "display_name"
	inline const std::string RET = "ret";                    // "ret"

	// Для ошибки
	inline const std::string ERROR_CODE = "code";            // "code"
	inline const std::string ERROR_MESSAGE = "message";      // "message"
	inline const std::string ERROR_DETAILS = "details";      // "details"
} // fields
} // rest
} // varan