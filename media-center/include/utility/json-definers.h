#include <string>

namespace varan {
namespace rest {
namespace fields {

	const std::string SOCKET_IP_ADRESS = "socket_ip";  // "socket_ip"
	const std::string SOCKET_PORT = "socket_port";     // "socket_port"

	const std::string RESULT = "result";           // "result"

	const std::string MAIN_STREAM = "main";            // "main"
	const std::string SUB_STREAM = "sub";              // "sub"
	const std::string NEURAL_STREAM = "neural";        // "neural"
	const std::string BIRD_VIEW_STREAM = "bird-view";  // "bird-view"

	const std::string STREAMS = "streams"; // "streams"
	const std::string CAMERAS = "cameras"; // "cameras"
	const std::string FIELDS = "fields";         // "fields"

	// Поля внутри пайплайнов при использовании get
	const std::string TYPE_STREAM = "type";           // "type"
	const std::string STATUS = "status";              // "status"
	const std::string WIDTH = "width";                // "width"
	const std::string HEIGHT = "height";              // "height"
	const std::string CODEC = "codec";                // "codec"
	const std::string FPS = "fps";                    // "fps"
	const std::string USE_UDP = "use_udp";            // "use_udp"
	const std::string RTSP_URL = "rtsp";              // "rtsp"
	const std::string LATENCY = "latency";            // "latency"
	const std::string RECORD_PATH = "record_path";    // "record_path"
	const std::string SEGMENT_LENGTH = "segment";     // "segment"
	const std::string RECONNECT = "reconnect";        // "reconnect"

	const std::string IP_ADRESS = "ip_adress";     // "ip_adress"
	const std::string PORT = "port";               // "port"
	const std::string USER = "user";               // "user"
	const std::string PASSWORD = "password";       // "password"
	const std::string PRODUCTION = "production";   // "production"

	// Общие поля
	const std::string DESCRIPTION = "description"; // "description"
	const std::string NAME = "name";               // "name"
	const std::string RET = "ret";                 // "ret"

	// Для ошибки
	const std::string ERROR_CODE = "code";         // "code"
	const std::string ERROR_MESSAGE = "message";   // "message"
	const std::string ERROR_DETAILS = "details";   // "details"
} // fields
} // rest
} // varan