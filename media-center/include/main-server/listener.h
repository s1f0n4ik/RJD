// Listener.hpp
#pragma once
#include <boost/asio.hpp>
#include <memory>
#include "main-server/router.h"

class UListener : public std::enable_shared_from_this<UListener> {
public:
    UListener(
        boost::asio::io_context& ioc, 
        boost::asio::ip::tcp::endpoint endpoint, 
        std::shared_ptr<URouter> router
    );

    void run();

private:
    void do_accept();
    void on_accept(boost::system::error_code ec);

private:
    boost::asio::ip::tcp::acceptor m_acceptor;
    boost::asio::ip::tcp::socket m_socket;
    std::shared_ptr<URouter> m_router;
};