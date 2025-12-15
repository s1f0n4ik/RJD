#include <boost/beast.hpp>
#include <boost/asio.hpp>
#include <iostream>
#include <thread>
#include <functional>
#include <string>

#include "console_utility.h"

namespace websocket = boost::beast::websocket;
namespace asio = boost::asio;

namespace varan {
namespace neural {

class UWebSocketClient : public std::enable_shared_from_this<UWebSocketClient> {
public:
    using MessageCallback = std::function<void(const std::string&)>;

    UWebSocketClient(asio::io_context& ioc,
        const std::string& host,
        const std::string& port,
        const std::string& target,
        const std::string& camera_name)
        : m_resolver(ioc),
        m_ws(ioc),
        m_ioc(ioc),
        m_timer(ioc),
        m_host(host),
        m_port(port),
        m_target(target),
        m_camera_name(camera_name) {
    }

    void set_message_callback(MessageCallback cb) {
        m_message_callback = std::move(cb);
    }

    void run() {
        log_connect("Starting connection...");
        start_resolve();
    }

    void send(const std::string& message) {
        asio::post(m_ws.get_executor(),
            [self = shared_from_this(), message]() {
                bool write_in_progress = !self->m_send_queue.empty();
                self->m_send_queue.push_back(message);
                if (!write_in_progress) {
                    self->do_write();
                }
            });
    }

private:
    // ------------------ LOGGING ------------------

    void log_connect(const std::string& msg) {
        std::cout << color::yellow << "[WebSocket " << m_camera_name << "] "
            << msg << color::reset << std::endl;
    }

    void log_recv(const std::string& msg) {
        std::cout << color::cyan << "[WebSocket " << m_camera_name << "] "
            << msg << color::reset << std::endl;
    }

    void log_send(const std::string& msg) {
        std::cout << color::magenta << "[WebSocket " << m_camera_name << "] "
            << msg << color::reset << std::endl;
    }

    void log_error(const std::string& msg) {
        std::cout << color::red << "[WebSocket " << m_camera_name << "] "
            << msg << color::reset << std::endl;
    }

    // ------------------ RECONNECT ------------------

    void schedule_reconnect() {
        log_error("Will retry connection in 10 seconds...");

        m_timer.expires_after(std::chrono::seconds(10));
        m_timer.async_wait([self = shared_from_this()](boost::beast::error_code ec) {
            if (!ec) {
                self->log_connect("Reconnecting...");
                self->start_resolve();
            }
            });
    }

    // ------------------ CONNECT PIPELINE ------------------

    void start_resolve() {
        m_resolver.async_resolve(m_host, m_port,
            [self = shared_from_this()](auto ec, auto results) {
                if (ec) {
                    self->log_error("Resolve failed: " + ec.message());
                    self->schedule_reconnect();
                    return;
                }
                asio::async_connect(self->m_ws.next_layer(),
                    results.begin(), results.end(),
                    std::bind(&UWebSocketClient::on_connect, self,
                        std::placeholders::_1));
            });
    }

    void on_connect(boost::beast::error_code ec) {
        if (ec) {
            log_error("Connect failed: " + ec.message());
            schedule_reconnect();
            return;
        }

        log_connect("Connected, performing handshake...");

        m_ws.async_handshake(m_host, m_target,
            std::bind(&UWebSocketClient::on_handshake, shared_from_this(),
                std::placeholders::_1));
    }

    void on_handshake(boost::beast::error_code ec) {
        if (ec) {
            log_error("Handshake failed: " + ec.message());
            schedule_reconnect();
            return;
        }

        log_connect("Handshake complete. Starting read loop...");
        do_read();
    }

    // ------------------ READ LOOP ------------------

    void do_read() {
        m_ws.async_read(m_buffer,
            [self = shared_from_this()](auto ec, std::size_t bytes) {
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
        m_sending = true;

        // Ћогируем отправл€емое сообщение (предполагаетс€, что m_send_queue.front() Ч это std::string или подобное)
        log_send("Sending message: " + m_send_queue.front());

        m_ws.async_write(asio::buffer(m_send_queue.front()),
            [self = shared_from_this()](boost::beast::error_code ec, std::size_t) {
                if (ec) {
                    self->log_error("Write failed: " + ec.message());
                    self->m_send_queue.clear();
                    self->m_sending = false;
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

    asio::io_context& m_ioc;
    asio::steady_timer m_timer;

    asio::ip::tcp::resolver m_resolver;
    websocket::stream<asio::ip::tcp::socket> m_ws;
    boost::beast::flat_buffer m_buffer;

    std::deque<std::string> m_send_queue;
    bool m_sending = false;

    std::string m_host;
    std::string m_port;
    std::string m_target;
    std::string m_camera_name;

    MessageCallback m_message_callback;
};

} // namespace neural
} // namespace varan
