#pragma once

#include <boost/beast.hpp>
#include <boost/asio.hpp>

#include <deque>
#include <functional>
#include <string>
#include <memory>
#include <atomic>

#include "gateway/utility/log.h"

namespace varan {
    namespace gateway {

        namespace websocket = boost::beast::websocket;
        namespace asio = boost::asio;
        using tcp = asio::ip::tcp;

        // WebSocket-клиент. Взят из media-center (include/websocket-client.h):
        // strand, очередь отправки, бинарные и текстовые фреймы, авто-реконнект.
        // Отличия: убрана привязка к камере, добавлен признак connected() для
        // heartbeat, логирование через ULog вместо цветного вывода.
        class UWebSocketClient
            : public std::enable_shared_from_this<UWebSocketClient>
        {
        public:
            using CMessageCallback = std::function<void(const std::string&)>;

            UWebSocketClient(
                asio::io_context& ioc,
                std::string host,
                std::string port,
                std::string target,
                std::string name
            )
                : m_strand(asio::make_strand(ioc))
                , m_resolver(m_strand)
                , m_timer(m_strand)
                , m_host(std::move(host))
                , m_port(std::move(port))
                , m_target(std::move(target))
                , m_name(std::move(name))
            {}

            void set_message_callback(CMessageCallback cb) {
                m_message_callback = std::move(cb);
            }

            bool connected() const {
                return m_connected.load();
            }

            void run() {
                recreate_ws();
                log("Starting connection to ws://" + m_host + ":" + m_port + m_target);
                start_resolve();
            }

            void stop() {
                bool expected = false;
                if (!m_stopping.compare_exchange_strong(expected, true)) {
                    return;
                }

                asio::post(
                    m_strand,
                    [self = shared_from_this()]() {
                        self->m_timer.cancel();
                        self->m_resolver.cancel();
                        self->m_send_queue.clear();
                        self->m_connected = false;
                        self->m_message_callback = nullptr;

                        if (self->m_ws && self->m_ws->is_open()) {
                            self->m_ws->async_close(
                                websocket::close_code::normal,
                                [self](boost::beast::error_code) {
                                    self->log("WebSocket closed");
                                });
                        }
                    });
            }

            void send(const std::string& message, bool is_binary = false) {
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
                    });
            }

        private:
            void recreate_ws() {
                m_ws.reset();
                m_ws = std::make_unique<websocket::stream<tcp::socket>>(m_strand);
                m_ws->binary(false);
                m_ws->set_option(websocket::stream_base::timeout::suggested(boost::beast::role_type::client));
            }

            void schedule_reconnect() {
                m_connected = false;

                if (m_stopping) {
                    return;
                }

                bool expected = false;
                if (!m_reconnecting.compare_exchange_strong(expected, true)) {
                    return;
                }

                log("Will retry connection in 10 seconds...");
                m_timer.expires_after(std::chrono::seconds(10));
                m_timer.async_wait(
                    [self = shared_from_this()](boost::beast::error_code ec) {
                        if (ec == asio::error::operation_aborted || self->m_stopping) {
                            return;
                        }
                        // Сбрасываем флаг до попытки: если она снова провалится,
                        // schedule_reconnect() поставит новый таймер. Так попытки
                        // идут бесконечно, а не гаснут после первой неудачной.
                        self->m_reconnecting = false;
                        self->log("Reconnecting...");
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
                    [self = shared_from_this()](boost::beast::error_code ec, tcp::resolver::results_type results) {
                        if (ec) {
                            self->log("Resolve failed: " + ec.message());
                            self->schedule_reconnect();
                            return;
                        }
                        asio::async_connect(
                            self->m_ws->next_layer(),
                            results,
                            [self](boost::beast::error_code ec, tcp::endpoint) {
                                self->on_connect(ec);
                            });
                    });
            }

            void on_connect(boost::beast::error_code ec) {
                if (m_stopping) {
                    return;
                }
                if (ec) {
                    log("Connect failed: " + ec.message());
                    schedule_reconnect();
                    return;
                }

                m_ws->async_handshake(
                    m_host,
                    m_target,
                    [self = shared_from_this()](boost::beast::error_code ec) {
                        self->on_handshake(ec);
                    });
            }

            void on_handshake(boost::beast::error_code ec) {
                if (m_stopping) {
                    return;
                }
                if (ec) {
                    log("Handshake failed: " + ec.message());
                    schedule_reconnect();
                    return;
                }

                m_reconnecting = false;
                m_connected = true;
                log("Handshake complete. Read loop started.");
                do_read();

                // После восстановления соединения досылаем накопленное.
                if (!m_send_queue.empty()) {
                    do_write();
                }
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
                            self->log("Read failed: " + ec.message());
                            self->schedule_reconnect();
                            return;
                        }
                        std::string data = boost::beast::buffers_to_string(self->m_buffer.data());
                        self->m_buffer.consume(bytes);
                        if (self->m_message_callback) {
                            self->m_message_callback(data);
                        }
                        self->do_read();
                    });
            }

            void do_write() {
                if (m_stopping || !m_ws || !m_ws->is_open() || m_send_queue.empty()) {
                    return;
                }

                auto& [msg, is_binary] = m_send_queue.front();
                m_ws->binary(is_binary);
                m_ws->async_write(
                    asio::buffer(msg.data(), msg.size()),
                    [self = shared_from_this()](boost::beast::error_code ec, std::size_t) {
                        if (ec == asio::error::operation_aborted) {
                            return;
                        }
                        if (ec) {
                            self->log("Write failed: " + ec.message());
                            self->m_send_queue.clear();
                            self->schedule_reconnect();
                            return;
                        }
                        self->m_send_queue.pop_front();
                        if (!self->m_send_queue.empty()) {
                            self->do_write();
                        }
                    });
            }

            void log(const std::string& msg) {
                ULog::info("ws:" + m_name, msg);
            }

        private:
            asio::strand<asio::io_context::executor_type> m_strand;
            asio::steady_timer m_timer;
            tcp::resolver m_resolver;

            std::unique_ptr<websocket::stream<tcp::socket>> m_ws;
            boost::beast::flat_buffer m_buffer;
            std::deque<std::pair<std::string, bool>> m_send_queue;

            std::atomic_bool m_stopping{ false };
            std::atomic_bool m_reconnecting{ false };
            std::atomic_bool m_connected{ false };

            std::string m_host;
            std::string m_port;
            std::string m_target;
            std::string m_name;

            CMessageCallback m_message_callback;
        };

    } // namespace gateway
} // namespace varan
