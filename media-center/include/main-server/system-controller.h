#pragma once

#include <boost/beast/http.hpp>
#include <boost/json.hpp>
#include <string>

#include "core/modules.h"
#include "core/platform.h"
#include "logger.h"

// Паспорт и телеметрия устройства: identity, модули, температура, диск, сеть.
// По этой ручке backend мастера обнаруживает и опрашивает устройства.
class USystemController {
public:
    USystemController(
        const varan::FModuleSet& modules,
        const varan::FPlatformInfo& platform,
        ULogger* logger = nullptr
    );

    boost::beast::http::response<boost::beast::http::string_body>
        get_info(const boost::beast::http::request<boost::beast::http::string_body>& req);

private:
    boost::json::object collect();

private:
    varan::FModuleSet m_modules;
    varan::FPlatformInfo m_platform;

    // machine-id стабилен между перезагрузками, читается один раз
    std::string m_device_id;

    ULogger* m_logger;
};
