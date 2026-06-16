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

	inline void log_request(ULogger* logger, const http::request<http::string_body>& req, const std::string& tag) {
		if (!logger) return;
		logger->info(tag + " from " + std::string(req[http::field::user_agent]));
		if (!req.body().empty()) {
			logger->receive("Body: " + req.body());
		}
	}

	inline void log_response(ULogger* logger, const std::string& tag, const boost::json::value& body) {
		if (!logger) return;
		logger->send(tag + " → " + boost::json::serialize(body));
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
	inline http::response<http::string_body> json_ok(
		ULogger* logger, const http::request<http::string_body>& req, const boost::json::value& body, const std::string& tag = ""
	) {
		log_response(logger, tag, body);
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