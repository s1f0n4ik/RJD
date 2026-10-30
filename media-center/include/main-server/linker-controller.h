#pragma once

#include <boost/beast/http.hpp>
#include <memory>
#include <filesystem>

#include "bird-view/linker.h"


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
		get_status(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_start(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_restart(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_stop(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_view_mode(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_surround(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_top(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_top_version(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_recalc(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_presets(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_preset(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_models(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_image(const boost::beast::http::request<boost::beast::http::string_body>& req);


private:
	std::shared_ptr<varan::birdview::ULinker> m_linker;
	ULogger* m_logger;
};