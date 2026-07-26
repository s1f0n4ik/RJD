// URestServer.cpp
#include "main-server/rest_server.h"
#include <iostream>

using namespace varan::neural;
using namespace boost;

namespace asio = boost::asio;
namespace http = boost::beast::http;


URestServer::URestServer(
    uint16_t port,
    std::shared_ptr<UMediaCenter> media_center,
    std::shared_ptr<varan::birdview::ULinker> linker, 
    std::shared_ptr<varan::neural::UNeuralLoader> loader,
    ULogger::ELoggerLevel level
)
    : m_port(port)
    , m_ioc(1)
    , m_logger("Rest Server", level)
{
    // Сначала маршруты для камер
    m_router = std::make_shared<URouter>();

    auto controller = std::make_shared<UController>(media_center, &m_logger);

    // Виртуальные потоки отдаются двумя путями: ручкой /streams и в GET /camera
    auto streams_ctrl = std::make_shared<UStreamsController>(linker, loader, &m_logger);
    controller->set_virtual_streams_provider([streams_ctrl] { return streams_ctrl->collect(); });

    // Регистрируем маршруты
    m_router->add_route(http::verb::get, "/camera",
        [controller](const auto& req) { return controller->get_camera(req); });
    m_router->add_route(http::verb::post, "/camera",
        [controller](const auto& req) { return controller->post_camera(req); });
    m_router->add_route(http::verb::patch, "/camera",
        [controller](const auto& req) { return controller->patch_camera(req); });
    m_router->add_route(http::verb::delete_, "/camera",
        [controller](const auto& req) { return controller->delete_camera(req); });

    // Маршруты для Линкер
    auto linker_ctrl = std::make_shared<ULinkerController>(linker, &m_logger);

    m_router->add_route(http::verb::get, "/linker/exports", 
        [linker_ctrl](const auto& r) { return linker_ctrl->get_exports(r); });
    m_router->add_route(http::verb::get, "/linker/export",
        [linker_ctrl](const auto& r) { return linker_ctrl->get_export(r); });
    m_router->add_route(http::verb::delete_, "/linker/export",
        [linker_ctrl](const auto& r) { return linker_ctrl->delete_export(r); });
    m_router->add_route(http::verb::get, "/linker/presets",
        [linker_ctrl](const auto& r) { return linker_ctrl->get_presets(r); });
    m_router->add_route(http::verb::get, "/linker/preset",
        [linker_ctrl](const auto& r) { return linker_ctrl->get_preset(r); });
    m_router->add_route(http::verb::get, "/linker/state", 
        [linker_ctrl](const auto& r) { return linker_ctrl->get_state(r); });
    m_router->add_route(http::verb::post, "/linker/state", 
        [linker_ctrl](const auto& r) { return linker_ctrl->post_state(r); });
    m_router->add_route(http::verb::get, "/linker/status", 
        [linker_ctrl](const auto& r) { return linker_ctrl->get_status(r); });
    m_router->add_route(http::verb::post, "/linker/start", 
        [linker_ctrl](const auto& r) { return linker_ctrl->post_start(r); });
    m_router->add_route(http::verb::post, "/linker/restart", 
        [linker_ctrl](const auto& r) { return linker_ctrl->post_restart(r); });
    m_router->add_route(http::verb::post, "/linker/stop", 
        [linker_ctrl](const auto& r) { return linker_ctrl->post_stop(r); });
    m_router->add_route(http::verb::post, "/linker/exports",
        [linker_ctrl](const auto& r) { return linker_ctrl->post_exports(r); });
    m_router->add_route(http::verb::post, "/linker/upload",
        [linker_ctrl](const auto& r) {return linker_ctrl->post_upload_image(r); });
    m_router->add_route(http::verb::post, "/linker/upload-model",
        [linker_ctrl](const auto& r) {return linker_ctrl->post_upload_model(r); });
    m_router->add_route(http::verb::get, "/linker/models",
        [linker_ctrl](const auto& r) {return linker_ctrl->get_models(r); });
    m_router->add_route(http::verb::get, "/linker/image",
        [linker_ctrl](const auto& r) { return linker_ctrl->get_image(r); });
    m_router->add_route(http::verb::post, "/linker/surround-camera",
        [linker_ctrl](const auto& r) { return linker_ctrl->post_surround_camera(r); });
    m_router->add_route(http::verb::post, "/linker/surround",
        [linker_ctrl](const auto& r) { return linker_ctrl->post_surround(r); });
    m_router->add_route(http::verb::get, "/linker/surround",
        [linker_ctrl](const auto& r) { return linker_ctrl->get_surround(r); });
    m_router->add_route(http::verb::post, "/linker/view-mode",
        [linker_ctrl](const auto& r) { return linker_ctrl->post_view_mode(r); });
    m_router->add_route(http::verb::post, "/linker/rotation",
        [linker_ctrl](const auto& r) { return linker_ctrl->post_rotation(r); });

    // Маршруты для Нейронки
    auto neural_ctrl = std::make_shared<UNeuralController>(loader, &m_logger);

    m_router->add_route(http::verb::get, "/neural/configurations", 
        [neural_ctrl](const auto& r) { return neural_ctrl->get_configurations(r); });
    m_router->add_route(http::verb::post, "/neural/configurations", 
        [neural_ctrl](const auto& r) { return neural_ctrl->post_configurations(r); });
    m_router->add_route(http::verb::get, "/neural/state", 
        [neural_ctrl](const auto& r) { return neural_ctrl->get_state(r); });
    m_router->add_route(http::verb::post, "/neural/state", 
        [neural_ctrl](const auto& r) { return neural_ctrl->post_state(r); });
    m_router->add_route(http::verb::get, "/neural/status", 
        [neural_ctrl](const auto& r) { return neural_ctrl->get_status(r); });
    m_router->add_route(http::verb::post, "/neural/start", 
        [neural_ctrl](const auto& r) { return neural_ctrl->post_start(r); });
    m_router->add_route(http::verb::post, "/neural/restart", 
        [neural_ctrl](const auto& r) { return neural_ctrl->post_restart(r); });
    m_router->add_route(http::verb::post, "/neural/stop", 
        [neural_ctrl](const auto& r) { return neural_ctrl->post_stop(r); });
    m_router->add_route(http::verb::get, "/neural/classes",
        [neural_ctrl](const auto& r) {return neural_ctrl->get_classes(r); });
    m_router->add_route(http::verb::get, "/neural/superclasses",
        [neural_ctrl](const auto& r) {return neural_ctrl->get_superclasses(r); });
    m_router->add_route(http::verb::get, "/neural/tracker-types",
        [neural_ctrl](const auto& r) {return neural_ctrl->get_tracker_types(r); });
    m_router->add_route(http::verb::get, "/neural/system",
        [neural_ctrl](const auto& r) {return neural_ctrl->get_system(r); });
    m_router->add_route(http::verb::get, "/neural/event-types",
        [neural_ctrl](const auto& r) {return neural_ctrl->get_event_types(r); });
    m_router->add_route(http::verb::post, "/neural/models",
        [neural_ctrl](const auto& r) {return neural_ctrl->post_model(r); });
    m_router->add_route(http::verb::get, "/neural/models",
        [neural_ctrl](const auto& r) {return neural_ctrl->get_models(r); });
    m_router->add_route(http::verb::get, "/neural/camera",
        [neural_ctrl](const auto& r) {return neural_ctrl->get_camera_config(r); });

    m_router->add_route(http::verb::get, "/streams",
        [streams_ctrl](const auto& r) { return streams_ctrl->get_streams(r); });
}

URestServer::~URestServer()
{
    stop();
}

void URestServer::async_start()
{
    if (m_running) {
        return;
    }

    m_running = true;

    m_thread = std::thread([this] {
        run();
    });
}

void URestServer::run() 
{
    try
    {
        auto endpoint = asio::ip::tcp::endpoint(asio::ip::tcp::v4(), m_port);

        m_listener = std::make_shared<UListener>(m_ioc, endpoint, m_router);

        m_listener->run();

        std::cout << "REST server started on port "
            << m_port << std::endl;

        m_ioc.run();
    }
    catch (const std::exception& e)
    {
        std::cerr << "REST server error: " << e.what() << std::endl;
    }

    m_running = false;
}

void URestServer::stop()
{
    if (!m_running) {
        return;
    }

    std::cout << "Stopping REST server...\n";

    asio::post(m_ioc, [this] {
        m_ioc.stop();
    });

    if (m_thread.joinable()) {
        m_thread.join();
    }

    m_running = false;
}