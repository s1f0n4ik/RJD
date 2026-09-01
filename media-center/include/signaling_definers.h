#pragma once

#include <boost/json.hpp>

// Определения для полей json, который используется для обмена сообщениями

#define SIG_RET "ret"
#define SIG_TYPE "type"
#define SIG_ANSWER "answer"
#define SIG_CLIENT "client_id"
#define SIG_CAMERA "camera"
#define SIG_DECRIPTION "description"
#define SIG_SENDER "sender"
#define SIG_TIMESTAMP "timestamp"
#define SIG_META "meta"

#define SIG_ERROR "error"

// Варинты полей RET
#define SIG_RET_FAULT "fault"
#define SIG_RET_SUCCESS "success"

// Варинты полея type
#define SIG_TYPE_CONNECT "connection"
#define SIG_TYPE_OPEN "open"
#define SIG_TYPE_CLOSE "close"
#define SIG_TYPE_ICE "ice"
#define SIG_TYPE_OFFER "offer"
#define SIG_TYPE_ANSWER "answer"
#define SIG_TYPE_STREAM_ERROR "stream_error"

#define SIG_ERROR_CODE "error_code"

// Числовой код ошибки; описания к нему хранит веб-интерфейс
#define SIG_CODE "code"

// Ключ потока камеры: stream_N или correction
#define SIG_STREAM "stream"

// Идентификатор webrtc-сессии
#define SIG_SESSION "session_id"

// Строковые коды ошибок потока: остаются рядом с числовыми, пока в сети
// встречаются сборки интерфейса, которые их читают
#define SIG_ERROR_RTSP_TIMEOUT       "RTSP_TIMEOUT"
#define SIG_ERROR_RTSP_DISCONNECTED  "RTSP_DISCONNECTED"
#define SIG_ERROR_RTSP_UNAUTHORIZED  "RTSP_UNAUTHORIZED"
#define SIG_ERROR_RTSP_NOT_FOUND     "RTSP_NOT_FOUND"
#define SIG_ERROR_GST_ERROR          "GST_ERROR"
#define SIG_ERROR_EOS                "EOS"

// Коды ошибок. Четыре цифры, тип читается по первой:
//   2xxx — сессия WebRTC
//   3xxx — поток камеры
//   4xxx — надстройки: коррекция 360, орбита, нейронка
//   5xxx — конфигурация и данные
// Описания живут в веб-интерфейсе; description остаётся служебным для логов.
namespace varan {
namespace signaling {

	// 2xxx — сессия WebRTC
	inline constexpr int CODE_SESSION_EXISTS        = 2001;  // сессия с этим клиентом уже есть
	inline constexpr int CODE_SESSION_NOT_FOUND     = 2002;  // сессии с этим клиентом нет
	inline constexpr int CODE_SESSION_CREATE_FAILED = 2003;  // не удалось создать сессию
	inline constexpr int CODE_SESSION_PIPELINE      = 2004;  // webrtcbin не поднялся
	inline constexpr int CODE_SESSION_NEGOTIATION   = 2005;  // отказ на offer, answer или ice
	inline constexpr int CODE_SESSION_INTERNAL      = 2006;  // внутренняя ошибка сессии
	inline constexpr int CODE_SESSION_RESTARTED     = 2007;  // сессию закрыл перезапуск потока
	inline constexpr int CODE_SESSION_CLOSED        = 2008;  // камера закрыла сессию сама

	// 3xxx — поток камеры
	inline constexpr int CODE_RTSP_TIMEOUT       = 3001;
	inline constexpr int CODE_RTSP_NOT_FOUND     = 3002;
	inline constexpr int CODE_RTSP_UNAUTHORIZED  = 3003;
	inline constexpr int CODE_RTSP_DISCONNECTED  = 3004;
	inline constexpr int CODE_GST_ERROR          = 3005;
	inline constexpr int CODE_EOS                = 3006;

	// 4xxx — надстройки
	inline constexpr int CODE_CORRECTION_NO_LINKS   = 4001;  // сопоставление калибровки не настроено
	inline constexpr int CODE_CORRECTION_BUILD      = 4002;  // пайплайн коррекции не собрался
	inline constexpr int CODE_CORRECTION_NO_STREAM  = 4003;  // коррекцию просили, пайплайна нет
	inline constexpr int CODE_ORBIT_NOT_RUNNING     = 4004;  // вывод 360 не запущен
	inline constexpr int CODE_ORBIT_REJECTED        = 4005;  // режим орбиты отвергнут

	// 5xxx — конфигурация и данные
	inline constexpr int CODE_NO_WEB_STREAM      = 5001;  // у камеры нет подпайплайна для webrtc
	inline constexpr int CODE_STREAM_NOT_EXISTS  = 5002;  // запрошенного потока у камеры нет
	inline constexpr int CODE_STREAM_NOT_VIEWED  = 5003;  // у потока нет назначения view
	inline constexpr int CODE_UNKNOWN_MESSAGE    = 5004;  // неизвестный тип сообщения
	inline constexpr int CODE_MESSAGE_MALFORMED  = 5005;  // сообщение не разобралось

	// Строковый код потока по числовому: пока живут оба формата
	inline const char* legacy_stream_code(int code) {
		switch (code) {
			case CODE_RTSP_TIMEOUT:      return SIG_ERROR_RTSP_TIMEOUT;
			case CODE_RTSP_NOT_FOUND:    return SIG_ERROR_RTSP_NOT_FOUND;
			case CODE_RTSP_UNAUTHORIZED: return SIG_ERROR_RTSP_UNAUTHORIZED;
			case CODE_RTSP_DISCONNECTED: return SIG_ERROR_RTSP_DISCONNECTED;
			case CODE_EOS:               return SIG_ERROR_EOS;
			default:                     return SIG_ERROR_GST_ERROR;
		}
	}

} // namespace signaling
} // namespace varan

// Варианты полей sender
#define SIG_SENDER_CLIENT "client"
#define SIG_SENDER_CAMERA "camera"
#define SIG_SENDER_CALIBRATE "calibrator"

// Дополнительные поля для ICE
#define SIG_ICE_CANDIDATE "candidate"
#define SIG_ICE_LINE_INDEX "sdpMLineIndex"

// Дополнительные поля для sdp
#define SIG_SDP "sdp"

// Поля для meta
#define SIG_META_WIDTH "width"
#define SIG_META_HEIGHT "height"
#define SIG_META_BYTE "byte"
#define SIG_META_SIZE "size"

#define SIG_META_CAMERA_ID "camera_id"

#define SIG_META_BYTE_UINT8 "uint8"

inline std::string make_socket_message(
	const std::string& type,
	bool is_success,
	const std::string* client,
	const std::string* sender,
	const boost::json::object* meta = nullptr,
	const std::vector<uint8_t>* binary = nullptr
)
{
	boost::json::object message;
	message[SIG_TYPE] = type;
	message[SIG_RET] = is_success;
	message[SIG_CLIENT] = client ? boost::json::value(*client) : boost::json::value(nullptr);
	message[SIG_SENDER] = sender ? boost::json::value(*sender) : boost::json::value(nullptr);
	message[SIG_META] = meta ? *meta : boost::json::object();
	if (!binary || binary->empty()) {
		return boost::json::serialize(message);
	}

	std::string json_str = boost::json::serialize(message);
	uint32_t json_size = static_cast<uint32_t>(json_str.size());

	// big-endian
	uint32_t be_size =
		((json_size >> 24) & 0xFF) |
		((json_size >> 8) & 0xFF00) |
		((json_size << 8) & 0xFF0000) |
		((json_size << 24) & 0xFF000000);

	// итоговый буфер
	std::string result;
	result.resize(4 + json_str.size() + binary->size());

	// копирование размера в виде big endian
	std::memcpy(result.data(), &be_size, 4);
	// копирование самого json
	std::memcpy(result.data() + 4, json_str.data(), json_str.size());
	// изображение
	std::memcpy(result.data() + 4 + json_str.size(), binary->data(), binary->size());

	return result;
}

inline std::string make_socket_error(
	const std::string& type,
	const std::string& description,
	const std::string* client,
	const std::string* sender
) {
	boost::json::object meta;
	meta[SIG_DECRIPTION] = description;

	return make_socket_message(type, false, client, sender, &meta);
}