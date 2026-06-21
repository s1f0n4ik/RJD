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

// Коды ошибок
#define SIG_ERROR_RTSP_TIMEOUT       "RTSP_TIMEOUT"
#define SIG_ERROR_RTSP_DISCONNECTED  "RTSP_DISCONNECTED"
#define SIG_ERROR_RTSP_UNAUTHORIZED  "RTSP_UNAUTHORIZED"
#define SIG_ERROR_RTSP_NOT_FOUND     "RTSP_NOT_FOUND"
#define SIG_ERROR_GST_ERROR          "GST_ERROR"
#define SIG_ERROR_EOS                "EOS"

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