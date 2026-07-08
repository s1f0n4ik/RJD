#pragma once

#include <boost/beast.hpp>
#include <boost/asio.hpp>

#include <functional>
#include <unordered_map>
#include <string>
#include <memory>
#include <optional>

namespace varan {
    namespace gateway {

        namespace http = boost::beast::http;
        namespace beast = boost::beast;
        namespace asio = boost::asio;

        // Роутер REST. Взят из media-center (main-server/router). Ключ — метод+path,
        // query отбрасывается. string_body держит и текст, и бинарные тела (image).
        class URouter {
        public:
            using FRequest = http::request<http::string_body>;
            using FResponse = http::response<http::string_body>;
            using CHttpHandler = std::function<FResponse(const FRequest&)>;

            void add_route(http::verb method, const std::string& path, CHttpHandler handler) {
                m_routes[key(method, path)] = std::move(handler);
            }

            FResponse route(const FRequest& req) const {
                std::string_view target = req.target();
                std::string_view path = target;
                if (auto pos = target.find('?'); pos != std::string_view::npos) {
                    path = target.substr(0, pos);
                }

                auto it = m_routes.find(key(req.method(), std::string(path)));
                if (it != m_routes.end()) {
                    return it->second(req);
                }

                FResponse res{ http::status::not_found, req.version() };
                res.set(http::field::content_type, "application/json");
                res.body() = R"({"error":"Not found"})";
                res.prepare_payload();
                return res;
            }

        private:
            static std::string key(http::verb method, const std::string& path) {
                return std::to_string(static_cast<int>(method)) + ":" + path;
            }

            std::unordered_map<std::string, CHttpHandler> m_routes;
        };

        // Сессия одного HTTP-соединения. Обрабатывает preflight OPTIONS и добавляет
        // CORS-заголовки, как в media-center.
        class UHttpSession : public std::enable_shared_from_this<UHttpSession> {
        public:
            UHttpSession(asio::ip::tcp::socket socket, std::shared_ptr<URouter> router)
                : m_stream(std::move(socket))
                , m_strand(asio::make_strand(m_stream.get_executor()))
                , m_router(std::move(router))
            {}

            void run() { do_read(); }

        private:
            void do_read() {
                m_request = {};
                // Кадры с изображением крупные, снимаем дефолтный лимит тела.
                m_parser.emplace();
                m_parser->body_limit(64ull * 1024 * 1024);
                http::async_read(m_stream, m_buffer, *m_parser,
                    asio::bind_executor(m_strand,
                        beast::bind_front_handler(&UHttpSession::on_read, shared_from_this())));
            }

            void on_read(beast::error_code ec, std::size_t) {
                if (ec == http::error::end_of_stream) return do_close();
                if (ec) return;

                m_request = m_parser->release();

                if (m_request.method() == http::verb::options) {
                    URouter::FResponse res{ http::status::no_content, m_request.version() };
                    res.set(http::field::server, "message-gateway");
                    res.set(http::field::access_control_max_age, "86400");
                    add_cors(res);
                    res.content_length(0);
                    res.keep_alive(m_request.keep_alive());
                    return write(std::move(res));
                }

                auto res = m_router->route(m_request);
                res.keep_alive(m_request.keep_alive());
                add_cors(res);
                write(std::move(res));
            }

            void write(URouter::FResponse&& res) {
                auto sp = std::make_shared<URouter::FResponse>(std::move(res));
                http::async_write(m_stream, *sp,
                    asio::bind_executor(m_strand,
                        [self = shared_from_this(), sp](beast::error_code ec, std::size_t) {
                            if (ec) return;
                            if (!sp->keep_alive()) self->do_close();
                            else self->do_read();
                        }));
            }

            void do_close() {
                beast::error_code ec;
                m_stream.socket().shutdown(asio::ip::tcp::socket::shutdown_send, ec);
            }

            static void add_cors(URouter::FResponse& res) {
                res.set(http::field::access_control_allow_origin, "*");
                res.set(http::field::access_control_allow_methods, "GET, POST, PUT, PATCH, DELETE, OPTIONS");
                res.set(http::field::access_control_allow_headers, "Content-Type, Authorization");
            }

            beast::tcp_stream m_stream;
            asio::strand<asio::any_io_executor> m_strand;
            beast::flat_buffer m_buffer;
            std::optional<http::request_parser<http::string_body>> m_parser;
            URouter::FRequest m_request;
            std::shared_ptr<URouter> m_router;
        };

        // Приёмщик соединений. Взят из media-center (main-server/listener).
        class UListener : public std::enable_shared_from_this<UListener> {
        public:
            UListener(asio::io_context& ioc, asio::ip::tcp::endpoint endpoint, std::shared_ptr<URouter> router)
                : m_acceptor(ioc), m_socket(ioc), m_router(std::move(router))
            {
                beast::error_code ec;
                m_acceptor.open(endpoint.protocol(), ec);
                m_acceptor.set_option(asio::socket_base::reuse_address(true), ec);
                m_acceptor.bind(endpoint, ec);
                m_acceptor.listen(asio::socket_base::max_listen_connections, ec);
            }

            void run() { do_accept(); }

        private:
            void do_accept() {
                m_acceptor.async_accept(m_socket,
                    std::bind(&UListener::on_accept, shared_from_this(), std::placeholders::_1));
            }

            void on_accept(beast::error_code ec) {
                if (!ec) {
                    std::make_shared<UHttpSession>(std::move(m_socket), m_router)->run();
                }
                do_accept();
            }

            asio::ip::tcp::acceptor m_acceptor;
            asio::ip::tcp::socket m_socket;
            std::shared_ptr<URouter> m_router;
        };

    } // namespace gateway
} // namespace varan
