#pragma once
// usignaling_server.hpp
// WebSocket signaling server with multiple rooms (sessions) support.
// Uses Boost.Beast and Boost.Asio + nlohmann::json for optional parsing.
// Internal fields prefixed with m_

#include <boost/asio.hpp>
#include <boost/beast.hpp>
#include <boost/beast/websocket.hpp>
#include <boost/beast/http.hpp>

#include <nlohmann/json.hpp>

#include <memory>
#include <set>
#include <unordered_map>
#include <mutex>
#include <deque>
#include <atomic>
#include <string>

#include "camera.h"

namespace varan {
namespace neural {

namespace asio = boost::asio;
namespace beast = boost::beast;
namespace websocket = beast::websocket;
namespace http = beast::http;
using tcp = asio::ip::tcp;
using json = nlohmann::json;

class USignalingServer; // forward

class UWSSession : public std::enable_shared_from_this<UWSSession> {
public:
    UWSSession(tcp::socket socket, USignalingServer& server, asio::io_context& ioc);

    ~UWSSession();

    // Start handshake and reading, accept with HTTP request to parse room_id
    void start();

    // Отправлояет сообщение
    void send_text(std::string const& message);

    void close();

    std::string id() const;
    std::string const& room_id() const { return m_room_id; }

private:
    // Accept with HTTP request (to get room_id)
    void on_accept(beast::error_code ec);
    void on_http_read(beast::error_code ec, std::size_t bytes_transferred);

    void do_read();
    void on_read(beast::error_code ec, std::size_t bytes_transferred);

    void do_write();
    void on_write(beast::error_code ec, std::size_t bytes_transferred);

    void send_http_error();

private:
    websocket::stream<tcp::socket> m_ws;
    USignalingServer& m_server;

    std::mutex m_write_mutex;
    std::deque<std::string> m_write_queue;

    beast::flat_buffer m_http_buffer;  // для http::async_read
    beast::flat_buffer m_ws_buffer;    // для websocket::async_read
    std::atomic<bool> m_closed{ false };

    std::string m_room_id;
    http::request<http::string_body> m_req;

    boost::asio::strand<boost::asio::io_context::executor_type> m_strand;

    boost::asio::io_context& m_io_context;
};

using session_ptr = std::shared_ptr<UWSSession>;

class USignalingServer : public std::enable_shared_from_this<USignalingServer> {
public:
    USignalingServer(asio::io_context& ioc);

    // Запуск потока
    bool start(const std::string& ip, int port);

    void stop();

    // Взаимодействие с сессиями
    void register_session(session_ptr s);
    void unregister_session(session_ptr s);

    // Взаимодействия с камерами, которые определяют данные
    void register_room_camera(std::shared_ptr<UCamera> camera);
    void unregister_room_camera(const std::string& camera_name);

    void join_room(std::string const& room_id, session_ptr s);
    void leave_room(std::string const& room_id, session_ptr s);

    // Функция обработчик при получении сообщений от клиента
    void on_client_message(const std::string& room_id, const std::string& msg, session_ptr sender);

    // Отправка сообщения во все сессии в комнате
    void broadcast_to_room(std::string const& room_id, std::string const& msg, session_ptr exclude);

private:
    void do_accept();

private:
    asio::io_context& m_ioc;
    tcp::acceptor m_acceptor;
    tcp::endpoint m_endpoint;

    std::thread m_thread;
    std::atomic<bool> m_running;

    std::set<session_ptr> m_sessions;
    std::mutex m_sessions_mutex;

    // Ключ - название комнаты, Значение - набор сессий, которые закреплены за комнатой
    std::unordered_map<std::string, std::set<session_ptr>> m_rooms;
    std::mutex m_rooms_mutex;

    // Ключ - название комнаты, Значение - камера, которая закреплена за комнатой
    std::unordered_map<std::string, std::shared_ptr<UCamera>> m_cameras;
    std::mutex m_cameras_mutex;

    void run();
};

} // namespace neural
} // namespace varan


