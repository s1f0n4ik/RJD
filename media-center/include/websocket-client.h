#pragma once

#include <boost/beast.hpp>
#include <boost/asio.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <deque>
#include <functional>
#include <memory>
#include <optional>
#include <random>
#include <string>
#include <thread>

#include "console_utility.h"
#include "logger.h"

namespace websocket = boost::beast::websocket;
namespace asio = boost::asio;
using tcp = asio::ip::tcp;

namespace varan {
    namespace neural {

        class UWebSocketClient
            : public std::enable_shared_from_this<UWebSocketClient>
        {
        private:

            // Стадия подключения клиента к сигналингу
            enum class EConnectionState {
                Idle,
                Connecting,
                Connected,
                WaitingRetry
            };

        public:
            using MessageCallback = std::function<void(const std::string&)>;

        public:

            UWebSocketClient(
                asio::io_context& ioc,
                const std::string& host,
                const std::string& port,
                const std::string& target,
                const std::string& camera_name,
                ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
            )

                : m_ioc(ioc)
                , m_strand(asio::make_strand(ioc))
                , m_timer(m_strand)
                , m_resolver(m_strand)
                , m_rng(std::random_device{}())
                , m_host(host)
                , m_port(port)
                , m_target(target)
                , m_camera_name(camera_name)
                , m_logger("WebSocket " + camera_name, level)
            {}

        public:

            void set_message_callback(MessageCallback cb) {
                m_message_callback = std::move(cb);
            }

            void run() {
                // Держит io_context живым, пока клиент не остановлен
                m_work_guard.emplace(asio::make_work_guard(m_ioc));

                recreate_ws();

                m_state = EConnectionState::Connecting;

                m_logger.debug("connecting to " + m_host + ":" + m_port + m_target);

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
                        self->m_timer.cancel();
                        self->m_resolver.cancel();
                        self->m_send_queue.clear();
                        self->m_sending = false;
                        self->m_message_callback = nullptr;
                        self->m_state = EConnectionState::Idle;

                        if (self->m_ws && self->m_ws->is_open()) {
                            self->m_ws->async_close(
                                websocket::close_code::normal,
                                [self](boost::beast::error_code) {
                                    self->m_logger.debug("closed");
                                    self->m_work_guard.reset();
                                });
                        }
                        else {
                            self->m_work_guard.reset();
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

                        // Вне состояния Connected сообщение не ставится в очередь
                        if (self->m_state != EConnectionState::Connected) {
                            self->m_logger.debug("dropped outgoing message, "
                                + std::to_string(message.size()) + " bytes, no connection");
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

            // Задержки повторов в секундах, последняя действует дальше без роста
            std::chrono::milliseconds next_delay() {
                static constexpr std::array<int, 4> steps{ 2, 4, 8, 15 };

                const std::size_t index = std::min(m_retry_attempts, steps.size() - 1);
                ++m_retry_attempts;

                // Разброс +-20% от базовой задержки
                std::uniform_real_distribution<double> spread(0.8, 1.2);
                const double seconds = steps[index] * spread(m_rng);

                return std::chrono::milliseconds(static_cast<long long>(seconds * 1000.0));
            }

            void schedule_reconnect(const std::string& reason) {
                if (m_stopping) {
                    return;
                }

                // Таймер уже взведён другой веткой
                if (m_state == EConnectionState::WaitingRetry) {
                    return;
                }

                if (m_disconnected_at == std::chrono::steady_clock::time_point{}) {
                    m_disconnected_at = std::chrono::steady_clock::now();
                    m_logger.warn("signaling connection lost: " + reason);
                }
                else {
                    m_logger.debug("attempt " + std::to_string(m_retry_attempts) + " failed: " + reason);
                }

                m_state = EConnectionState::WaitingRetry;

                // Очередь отправки не переживает обрыв
                m_send_queue.clear();
                m_sending = false;

                const auto delay = next_delay();

                m_logger.debug("retry " + std::to_string(m_retry_attempts)
                    + " in " + std::to_string(delay.count()) + " ms");

                m_timer.expires_after(delay);

                m_timer.async_wait(
                    [self = shared_from_this()]
                    (boost::beast::error_code ec) {
                        if (ec == asio::error::operation_aborted) {
                            return;
                        }

                        if (self->m_stopping) {
                            return;
                        }

                        self->m_state = EConnectionState::Connecting;
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
                        if (ec == asio::error::operation_aborted) {
                            return;
                        }

                        if (ec) {
                            self->schedule_reconnect("resolve failed: " + ec.message());
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
                if (ec == asio::error::operation_aborted) {
                    return;
                }

                if (m_stopping) {
                    return;
                }

                if (ec){
                    schedule_reconnect("connect failed: " + ec.message());
                    return;
                }

                m_logger.debug("connected, performing handshake");

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
                    schedule_reconnect("handshake failed: " + ec.message());
                    return;
                }

                m_state = EConnectionState::Connected;

                if (m_disconnected_at != std::chrono::steady_clock::time_point{}) {
                    const auto downtime = std::chrono::duration_cast<std::chrono::seconds>(
                        std::chrono::steady_clock::now() - m_disconnected_at).count();

                    m_logger.info("signaling restored after " + std::to_string(downtime)
                        + " s, attempts " + std::to_string(m_retry_attempts));
                }
                else {
                    m_logger.info("connected to signaling");
                }

                m_disconnected_at = {};
                m_retry_attempts = 0;

                do_read();

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
                            self->schedule_reconnect("read failed: " + ec.message());
                            return;
                        }

                        std::string data = boost::beast::buffers_to_string(self->m_buffer.data());

                        self->m_buffer.consume(bytes);
                        //self->log_recv("Received message: " + data);
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
                    //log_send("Sending binary message, size=" + std::to_string(msg.size()));
                }
                else {
                    //log_send("Sending message: " + msg);
                }

                m_ws->binary(is_binary);
                m_ws->async_write(
                    asio::buffer(msg.data(), msg.size()),
                    [self = shared_from_this()] (boost::beast::error_code ec,std::size_t) {
                        if (ec == asio::error::operation_aborted) {
                            return;
                        }

                        if (ec) {
                            self->m_send_queue.clear();
                            self->m_sending = false;
                            self->schedule_reconnect("write failed: " + ec.message());
                            return;
                        }

                        //self->log_connect("Message sent successfully");
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

            asio::io_context& m_ioc;

            asio::strand<asio::io_context::executor_type> m_strand;

            asio::steady_timer m_timer;

            tcp::resolver m_resolver;

            std::unique_ptr<websocket::stream<tcp::socket>> m_ws;

            boost::beast::flat_buffer m_buffer;

            std::deque<std::pair<std::string, bool>> m_send_queue;

            bool m_sending = false;

            std::atomic_bool m_stopping{ false };

            EConnectionState m_state = EConnectionState::Idle;

            std::size_t m_retry_attempts = 0;

            std::chrono::steady_clock::time_point m_disconnected_at{};

            std::optional<asio::executor_work_guard<asio::io_context::executor_type>> m_work_guard;

            std::mt19937 m_rng;

            std::string m_host;
            std::string m_port;
            std::string m_target;
            std::string m_camera_name;

            ULogger m_logger;

            MessageCallback m_message_callback;
        };

    } // namespace neural
} // namespace varan
