// Listener.cpp
#include "main-server/listener.h"
#include "main-server/httpsession.h"

using tcp = boost::asio::ip::tcp;
using namespace boost;

UListener::UListener(asio::io_context& ioc, tcp::endpoint endpoint, std::shared_ptr<URouter> router)
    : m_acceptor(ioc), m_socket(ioc), m_router(router)
{
    boost::system::error_code ec;
    m_acceptor.open(endpoint.protocol(), ec);
    m_acceptor.set_option(asio::socket_base::reuse_address(true), ec);
    m_acceptor.bind(endpoint, ec);
    m_acceptor.listen(asio::socket_base::max_listen_connections, ec);
}

void UListener::run() 
{ 
    do_accept(); 
}

void UListener::do_accept() 
{
    m_acceptor.async_accept(m_socket,
        std::bind(&UListener::on_accept, shared_from_this(), std::placeholders::_1)
    );
}

void UListener::on_accept(boost::system::error_code ec) 
{
    if (!ec) {
        std::make_shared<UHttpSession>(std::move(m_socket), m_router)->run();
    }
    do_accept();
}