#pragma once

#include <boost/beast/http.hpp>
#include <boost/json.hpp>
#include <string>

#include "logger.h"

namespace varan {
namespace rest {

	namespace http = boost::beast::http;

	/*
		Утилиты для REST-контроллеров.

		Все функции принимают ULogger* (может быть nullptr) и сами проверяют,
		стоит ли логировать. Это позволяет писать однообразный код:

			LOG_REQUEST(logger, req, "GET /neural/status");
			...
			return json_ok(logger, req, body);
	*/

	// ── Логирование ──

	// Тело дампится только для JSON: бинарники в websocket-лог не идут
	// level — уровень строки запроса: опросные ручки пишут её в DEBUG
	inline void log_request(ULogger* logger, const http::request<http::string_body>& req, const std::string& tag,
		ULogger::ELoggerLevel level = ULogger::ELoggerLevel::INFO) {
		if (!logger) return;
		logger->log(level, tag + " from " + std::string(req[http::field::user_agent]));
		if (req.body().empty()) return;

		const auto content_type = std::string(req[http::field::content_type]);
		if (content_type.find("application/json") != std::string::npos) {
			logger->receive("Body: " + req.body());
		}
		else {
			logger->receive("Body: <" + std::to_string(req.body().size()) + " bytes, "
				+ (content_type.empty() ? "no content-type" : content_type) + ">");
		}
	}

	inline void log_response(ULogger* logger, const std::string& tag, const boost::json::value& body,
		ULogger::ELoggerLevel level = ULogger::ELoggerLevel::SEND) {
		if (!logger) return;
		logger->log(level, tag + " → " + boost::json::serialize(body));
	}

	inline void log_error(ULogger* logger, const std::string& tag, const std::string& msg) {
		if (!logger) return;
		logger->error(tag + ": " + msg);
	}

	inline http::response<http::string_body> make_response(
		unsigned http_version, http::status status, const boost::json::value& body
	) {
		http::response<http::string_body> res{ status, http_version };
		res.set(http::field::content_type, "application/json");
		res.set(http::field::access_control_allow_origin, "*");
		res.body() = boost::json::serialize(body);
		res.prepare_payload();
		return res;
	}

	// Успешный ответ с логированием.
	// level — уровень дампа ответа: опросные ручки пишут его в TRACE
	inline http::response<http::string_body> json_ok(
		ULogger* logger, const http::request<http::string_body>& req, const boost::json::value& body, const std::string& tag = "",
		ULogger::ELoggerLevel level = ULogger::ELoggerLevel::SEND
	) {
		log_response(logger, tag, body, level);
		return make_response(req.version(), http::status::ok, body);
	}

	// Ответ-ошибка с логированием.
	inline http::response<http::string_body> json_error(
		ULogger* logger, const http::request<http::string_body>& req, http::status status, const std::string& msg, const std::string& tag = ""
	) {
		log_error(logger, tag, msg);
		boost::json::object body;
		body["error"] = msg;
		return make_response(req.version(), status, body);
	}

} // namespace rest
} // namespace varan