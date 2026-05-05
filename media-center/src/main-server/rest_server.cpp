// URestServer.cpp
#include "main-server/rest_server.h"
#include "main-server/listener.h"
#include <iostream>

using namespace varan::neural;
using namespace boost;

namespace asio = boost::asio;
namespace http = boost::beast::http;


URestServer::URestServer(uint16_t port,
    std::shared_ptr<UMediaCenter> media_center)
    : m_port(port), m_ioc(1), m_signals(m_ioc, SIGINT, SIGTERM)
{
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