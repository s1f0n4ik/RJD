#pragma once

#include <boost/beast/http.hpp>
#include <memory>

#include "neural/loader.h"
#include "logger.h"

/*
    REST для UNeuralLoader.

    GET  /neural/configurations          список конфигов (id, name)
    POST /neural/configurations          импорт нового файла конфигураций body: { "mode": "merge"|"replace", "data": {...} }
    GET  /neural/state                   текущий save-state { config_id, camera_id }
    POST /neural/state                   перезаписать save-state и (если работает) перезапуск body: { "config_id": "...", "camera_id": "..." }
    GET  /neural/status                  { running, config_id, camera_id, stream_id }
    POST /neural/start                   запустить supervisor (если не запущен)
    POST /neural/restart                 стоп + перечитать state + старт
    POST /neural/stop                    остановить supervisor
    GET  /neural/camera                  { "data": { "camera_id": "camera_3", "config_id": "railway_camera", "found": true } }
*/
class UNeuralController {
public:
    UNeuralController(std::shared_ptr<varan::neural::UNeuralLoader> loader, ULogger* logger = nullptr);

    boost::beast::http::response<boost::beast::http::string_body>
        get_configurations(const boost::beast::http::request<boost::beast::http::string_body>& req);

    boost::beast::http::response<boost::beast::http::string_body>
        post_configurations(const boost::beast::http::request<boost::beast::http::string_body>& req);

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
        get_classes(const boost::beast::http::request<boost::beast::http::string_body>& req);

    boost::beast::http::response<boost::beast::http::string_body>
        get_superclasses(const boost::beast::http::request<boost::beast::http::string_body>& req);

    boost::beast::http::response<boost::beast::http::string_body>
        get_models(const boost::beast::http::request<boost::beast::http::string_body>& req);

    boost::beast::http::response<boost::beast::http::string_body>
        post_model(const boost::beast::http::request<boost::beast::http::string_body>& req);

    boost::beast::http::response<boost::beast::http::string_body> 
        get_camera_config(const boost::beast::http::request<boost::beast::http::string_body>& req);

private:
    std::shared_ptr<varan::neural::UNeuralLoader> m_loader;
    ULogger* m_logger;
};