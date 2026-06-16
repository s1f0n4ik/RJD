#pragma once

#include <boost/beast/http.hpp>
#include <memory>
#include <filesystem>

#include "bird-view/linker.h"

/*
	REST для Linker'a.

	GET    /linker/exports  → список stitching-конфигов (id, name, cameras keys)
	GET    /linker/state    → текущий save-файл (export_id, cameras, stream_id)
	POST   /linker/state    → перезаписать save-файл (Линкер сам зовёт reload_from_state)
	GET    /linker/status   → { running, export_id }
	POST   /linker/start    → запустить, если не запущен
	POST   /linker/restart  → stop + reload + start
	POST   /linker/stop     → остановить
*/
class ULinkerController {
public:
	ULinkerController(std::shared_ptr<varan::birdview::ULinker> linker, ULogger* logger = nullptr);

	boost::beast::http::response<boost::beast::http::string_body>
		get_exports(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_export(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_state(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_state(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_status(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_start(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_restart(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_stop(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_exports(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_upload_image(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::file_body>
		get_image(const boost::beast::http::request<boost::beast::http::string_body>& req);


private:
	std::shared_ptr<varan::birdview::ULinker> m_linker;
	ULogger* m_logger;
};