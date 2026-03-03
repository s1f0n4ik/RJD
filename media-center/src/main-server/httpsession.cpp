// HttpSession.cpp
#include "main-server/httpsession.h"
#include <boost/beast/http.hpp>

namespace http = boost::beast::http;
namespace asio = boost::asio;
namespace beast = boost::beast;

UHttpSession::UHttpSession(asio::ip::tcp::socket socket, std::shared_ptr<URouter> router)
    : m_stream(std::move(socket))
    , m_strand(asio::make_strand(m_stream.get_executor()))
    , m_router(router) 
{
}

void UHttpSession::run() {
    do_read();
}

void UHttpSession::do_read() {
    m_request = {};
    http::async_read(m_stream, m_buffer, m_request,
        asio::bind_executor(
            m_strand,
            beast::bind_front_handler(&UHttpSession::on_read, shared_from_this())
        )
    );
}

void UHttpSession::on_read(beast::error_code ec, std::size_t) {
    if (ec == http::error::end_of_stream) return do_close();
    if (ec) return;

    auto res = m_router->route(m_request);
    auto sp = std::make_shared<http::response<http::string_body>>(std::move(res));

    http::async_write(m_stream, *sp,
        asio::bind_executor(m_strand,
            [self = shared_from_this(), sp](beast::error_code ec, std::size_t) {
                if (ec) return;
                if (!sp->keep_alive()) self->do_close();
                else self->do_read();
            }
        )
    );
}

void UHttpSession::do_close() {
    beast::error_code ec;
    m_stream.socket().shutdown(asio::ip::tcp::socket::shutdown_send, ec);
}