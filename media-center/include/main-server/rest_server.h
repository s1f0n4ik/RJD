// URestServer.hpp
#pragma once
#include <boost/asio.hpp>
#include <memory>

#include "main-server/controller.h"
#include "main-server/listener.h"

class URestServer {
public:
    URestServer(uint16_t port, std::shared_ptr<varan::neural::UMediaCenter> media_center);
    ~URestServer();

    void async_start();
    void stop(); 

private:
    void run();

private:
    boost::asio::io_context m_ioc;
    boost::asio::signal_set m_signals;
    uint16_t m_port;

    std::shared_ptr<URouter> m_router;
    std::shared_ptr<UListener> m_listener;

    std::thread m_thread;
    std::atomic<bool> m_running{ false };
};