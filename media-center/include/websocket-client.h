#pragma once

#include <boost/beast.hpp>
#include <boost/asio.hpp>

#include <iostream>
#include <deque>
#include <thread>
#include <functional>
#include <string>
#include <memory>
#include <atomic>

#include "console_utility.h"

namespace websocket = boost::beast::websocket;
namespace asio = boost::asio;
using tcp = asio::ip::tcp;

namespace varan {
    namespace neural {

        class UWebSocketClient
            : public std::enable_shared_from_this<UWebSocketClient>
        {
        public:
            using MessageCallback = std::function<void(const std::string&)>;

        public:

            UWebSocketClient(
                asio::io_context& ioc,
                const std::string& host,
                const std::string& port,
                const std::string& target,
                const std::string& camera_name
            )

                : m_ioc(ioc)
                , m_strand(asio::make_strand(ioc))
                , m_resolver(m_strand)
                , m_timer(m_strand)
                , m_host(host)
                , m_port(port)
                , m_target(target)
                , m_camera_name(camera_name)
            {}

        public:

            void set_message_callback(MessageCallback cb) {
                m_message_callback = std::move(cb);
            }

            void run() {
                recreate_ws();

                log_connect("Starting connection...");

                start_resolve();
            }

            void stop() {

                bool expected = false;

                if (!m_stopping.compare_exchange_strong(expected, true)) {
                    return;
                }

                asio::post(
                    m_strand,
                    [self = shared_from_this()]()
                    {
                        boost::beast::error_code ec;

                        self->m_timer.cancel();
                        self->m_resolver.cancel();
                        self->m_send_queue.clear();
                        self->m_sending = false;
                        self->m_message_callback = nullptr;

                        if (self->m_ws && self->m_ws->is_open()) {
                            self->m_ws->async_close(
                                websocket::close_code::normal,
                                [self](boost::beast::error_code) {
                                    self->log_connect("WebSocket closed");
                                });
                        }
                    });
            }

            void send(const std::string& message, bool is_binary = false){
                asio::post(
                    m_strand,
                    [self = shared_from_this(), message, is_binary]() {
                        if (self->m_stopping) {
                            return;
                        }
                        bool write_in_progress = !self->m_send_queue.empty();

                        self->m_send_queue.push_back({ message, is_binary });

                        if (!write_in_progress) {
                            self->do_write();
                        }
                    }
                );
            }

        private:

            void recreate_ws() {
                m_ws.reset();
                m_ws = std::make_unique<websocket::stream<tcp::socket>>(m_strand);
                m_ws->binary(false);
                m_ws->set_option(websocket::stream_base::timeout::suggested(boost::beast::role_type::client));
            }

        private:

            void schedule_reconnect() {
                if (m_stopping) {
                    return;
                }

                bool expected = false;

                if (!m_reconnecting.compare_exchange_strong(expected, true)) {
                    return;
                }

                log_error("Will retry connection in 10 seconds...");
                m_timer.expires_after(std::chrono::seconds(10));

                m_timer.async_wait(
                    [self = shared_from_this()]
                    (boost::beast::error_code ec) {
                        if (ec == asio::error::operation_aborted) {
                            return;
                        }

                        if (self->m_stopping) {
                            return;
                        }

                        self->log_connect("Reconnecting...");
                        self->recreate_ws();
                        self->start_resolve();
                    });
            }

            void start_resolve() {
                if (m_stopping) {
                    return;
                }

                m_resolver.async_resolve(
                    m_host,
                    m_port,
                    [self = shared_from_this()] (boost::beast::error_code ec, tcp::resolver::results_type results) {
                        if (ec) {
                            self->log_error("Resolve failed: " + ec.message());
                            self->schedule_reconnect();
                            return;
                        }

                        asio::async_connect(
                            self->m_ws->next_layer(),
                            results,
                            [self] (boost::beast::error_code ec, tcp::endpoint) {
                                self->on_connect(ec);
                            });
                    });
            }

            void on_connect(boost::beast::error_code ec) {
                if (m_stopping) {
                    return;
                }

                if (ec){
                    log_error("Connect failed: " + ec.message());
                    schedule_reconnect();
                    return;
                }

                log_connect("Connected, performing handshake...");

                m_ws->async_handshake(
                    m_host,
                    m_target,
                    [self = shared_from_this()] (boost::beast::error_code ec) {
                        self->on_handshake(ec);
                    });
            }

            void on_handshake(boost::beast::error_code ec) {
                if (m_stopping) {
                    return;
                }

                if (ec) {
                    log_error("Handshake failed: " + ec.message());
                    schedule_reconnect();
                    return;
                }
                m_reconnecting = false;

                log_connect("Handshake complete. Starting read loop...");
                do_read();
            }

            void do_read() {
                if (m_stopping) {
                    return;
                }

                m_ws->async_read(
                    m_buffer,
                    [self = shared_from_this()](boost::beast::error_code ec, std::size_t bytes) {
                        if (ec == asio::error::operation_aborted) {
                            return;
                        }

                        if (ec) {
                            self->log_error("Read failed: " + ec.message());
                            self->schedule_reconnect();
                            return;
                        }

                        std::string data = boost::beast::buffers_to_string(self->m_buffer.data());

                        self->m_buffer.consume(bytes);
                        self->log_recv("Received message: " + data);
                        if (self->m_message_callback) {
                            self->m_message_callback(data);
                        }

                        self->do_read();
                    });
            }

            void do_write() {
                if (m_stopping) {
                    return;
                }
                if (!m_ws || !m_ws->is_open()) {
                    return;
                }
                if (m_send_queue.empty()) {
                    return;
                }

                m_sending = true;
                auto& [msg, is_binary] = m_send_queue.front();
                if (is_binary) {
                    log_send("Sending binary message, size=" + std::to_string(msg.size()));
                }
                else {
                    log_send("Sending message: " + msg);
                }

                m_ws->binary(is_binary);
                m_ws->async_write(
                    asio::buffer(msg.data(), msg.size()),
                    [self = shared_from_this()] (boost::beast::error_code ec,std::size_t) {
                        if (ec == asio::error::operation_aborted) {
                            return;
                        }

                        if (ec) {
                            self->log_error("Write failed: " + ec.message());
                            self->m_send_queue.clear();
                            self->m_sending = false;
                            self->schedule_reconnect();
                            return;
                        }

                        self->log_connect("Message sent successfully");
                        self->m_send_queue.pop_front();
                        if (!self->m_send_queue.empty()) {
                            self->do_write();
                        }
                        else {
                            self->m_sending = false;
                        }
                    });
            }

        private:

            void log_connect(const std::string& msg) {
                std::cout
                    << color::yellow
                    << "[WebSocket " << m_camera_name << "] "
                    << msg
                    << color::reset
                    << std::endl;
            }

            void log_recv(const std::string& msg) {
                std::cout
                    << color::cyan
                    << "[WebSocket " << m_camera_name << "] "
                    << msg
                    << color::reset
                    << std::endl;
            }

            void log_send(const std::string& msg) {
                std::cout
                    << color::magenta
                    << "[WebSocket " << m_camera_name << "] "
                    << msg
                    << color::reset
                    << std::endl;
            }

            void log_error(const std::string& msg) {
                std::cout
                    << color::red
                    << "[WebSocket " << m_camera_name << "] "
                    << msg
                    << color::reset
                    << std::endl;
            }

        private:

            asio::io_context& m_ioc;

            asio::strand<asio::io_context::executor_type> m_strand;

            asio::steady_timer m_timer;

            tcp::resolver m_resolver;

            std::unique_ptr<websocket::stream<tcp::socket>> m_ws;

            boost::beast::flat_buffer m_buffer;

            std::deque<std::pair<std::string, bool>> m_send_queue;

            bool m_sending = false;

            std::atomic_bool m_stopping{ false };
            std::atomic_bool m_reconnecting{ false };

            std::string m_host;
            std::string m_port;
            std::string m_target;
            std::string m_camera_name;

            MessageCallback m_message_callback;
        };

    } // namespace neural
} // namespace varan