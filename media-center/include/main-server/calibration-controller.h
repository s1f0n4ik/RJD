#pragma once

#include <boost/beast/http.hpp>
#include <memory>

#include "logger.h"

// Сопоставление камер birdview и конфигураций калибровки: links.json
class UCalibrationController {
public:
    explicit UCalibrationController(ULogger* logger);

    boost::beast::http::response<boost::beast::http::string_body>
    get_links(const boost::beast::http::request<boost::beast::http::string_body>& req);

    boost::beast::http::response<boost::beast::http::string_body>
    post_links(const boost::beast::http::request<boost::beast::http::string_body>& req);

private:
    ULogger* m_logger = nullptr;
};
