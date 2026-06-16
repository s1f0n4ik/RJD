// URestServer.hpp
#pragma once
#include <boost/asio.hpp>
#include <memory>

#include "main-server/controller.h"
#include "main-server/linker-controller.h"
#include "main-server/neural-controller.h"
#include "main-server/listener.h"

class URestServer {
public:
    URestServer(
        uint16_t port, 
        std::shared_ptr<varan::neural::UMediaCenter> media_center, 
        std::shared_ptr<varan::birdview::ULinker> linker,
        std::shared_ptr<varan::neural::UNeuralLoader> loader,
        ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
    );

    ~URestServer();

    void async_start();
    void stop(); 

private:
    void run();

private:
    boost::asio::io_context m_ioc;
    uint16_t m_port;

    std::shared_ptr<URouter> m_router;
    std::shared_ptr<UListener> m_listener;

    std::thread m_thread;
    std::atomic<bool> m_running{ false };

    ULogger m_logger;
};