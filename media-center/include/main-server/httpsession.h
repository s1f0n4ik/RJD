// HttpSession.hpp
#pragma once
#include <boost/beast.hpp>
#include <boost/asio.hpp>
#include <memory>
#include <optional>

#include "main-server/router.h"

class UHttpSession : public std::enable_shared_from_this<UHttpSession> {
public:
    UHttpSession(boost::asio::ip::tcp::socket socket, std::shared_ptr<URouter> router);

    void run();

private:
    void do_read();
    void on_read(boost::beast::error_code ec, std::size_t bytes);
    void do_close();

    static void add_cors(http::response<http::string_body>& res);

private:
    boost::beast::tcp_stream m_stream;
    boost::asio::strand<boost::asio::any_io_executor> m_strand;
    boost::beast::flat_buffer m_buffer;
    // Парсер на каждый запрос: дефолтный лимит тела 8 МБ режет .glb модели
    std::optional<boost::beast::http::request_parser<boost::beast::http::string_body>> m_parser;
    boost::beast::http::request<boost::beast::http::string_body> m_request;
    std::shared_ptr<URouter> m_router;
};