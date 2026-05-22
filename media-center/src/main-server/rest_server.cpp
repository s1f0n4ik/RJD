// URestServer.cpp
#include "main-server/rest_server.h"
#include "main-server/linker-controller.h"
#include "main-server/listener.h"
#include <iostream>

using namespace varan::neural;
using namespace boost;

namespace asio = boost::asio;
namespace http = boost::beast::http;


URestServer::URestServer(
    uint16_t port,
    std::shared_ptr<UMediaCenter> media_center,
    std::shared_ptr<varan::birdview::ULinker> linker, 
    ULogger::ELoggerLevel level
)
    : m_port(port)
    , m_ioc(1)
    , m_logger("Rest Server", level)
{
    // Сначала маршруты для камер
    m_router = std::make_shared<URouter>();

    auto controller = std::make_shared<UController>(media_center);
    
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
    auto linker_ctrl = std::make_shared<ULinkerController>(linker);

    m_router->add_route(http::verb::get, "/linker/exports", 
        [linker_ctrl](const auto& r) { return linker_ctrl->get_exports(r); });
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