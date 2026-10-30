#pragma once

#include <boost/beast/http.hpp>
#include <memory>

#include "core/machine-config.h"
#include "logger.h"

// Приём конфигурации от мастера: пакет с ревизией и файлы по sha256
class UConfigController {
public:
    UConfigController(std::shared_ptr<varan::UMachineConfig> config, ULogger* logger = nullptr);

    boost::beast::http::response<boost::beast::http::string_body>
        get_config(const boost::beast::http::request<boost::beast::http::string_body>& req);
    boost::beast::http::response<boost::beast::http::string_body>
        put_config(const boost::beast::http::request<boost::beast::http::string_body>& req);
    boost::beast::http::response<boost::beast::http::string_body>
        put_asset(const boost::beast::http::request<boost::beast::http::string_body>& req);

private:
    std::shared_ptr<varan::UMachineConfig> m_config;
    ULogger* m_logger;
};
