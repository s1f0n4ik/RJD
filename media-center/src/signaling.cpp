#include "signaling.h"

#include <iostream>
#include <sstream>
#include <utility>

#include "console_utility.h"

using namespace std;

namespace varan {
namespace neural {

// ---------------- UWSSession ----------------

UWSSession::UWSSession(tcp::socket socket, USignalingServer& server, asio::io_context& ioc)
    : m_ws(std::move(socket))
    , m_server(server)
    , m_strand(asio::make_strand(ioc))
    , m_io_context(ioc)
{
}

UWSSession::~UWSSession() {
    std::cout << "SESSION DEAD!!!!!\n";
}

void UWSSession::start() {
    // Сначала асинхронно читаем HTTP запрос
    boost::asio::post(m_strand, [self = shared_from_this()]() {
        http::async_read(
            self->m_ws.next_layer(),
            self->m_http_buffer,
            self->m_req,
            beast::bind_front_handler(&UWSSession::on_http_read, self)
        );
    });
}

void UWSSession::on_http_read(beast::error_code ec, std::size_t bytes_transferred) {
    boost::ignore_unused(bytes_transferred);

    if (ec) {
        std::cerr << "[WSSession " << id() << "] HTTP read error: " << ec.message() << "\n";
        m_server.unregister_session(shared_from_this());
        return;
    }

    // Извлекаем room_id из URI запроса
    std::string target = std::string(m_req.target());
    m_room_id = (target.empty() || target == "/") ? "default" :
                (target.front() == '/' ? target.substr(1) : target);

    std::cout << color::cyan << "[WSSession " << id() << "] Recieved URL request: " << m_req.target() 
              <<"; Recieved room id: " << m_room_id << color::reset << std::endl;

    if (!websocket::is_upgrade(m_req)) {
        std::cerr << "[WSSession " << id() << "] Not a WebSocket upgrade\n";
        // Отправляем HTTP ошибку
        send_http_error();
        m_server.unregister_session(shared_from_this());
        return;
    }

    // Принимаем WebSocket соединение с этим запросом
    boost::asio::post(m_strand, [self = shared_from_this()]() {
        self->m_ws.async_accept(
            self->m_req,
            beast::bind_front_handler(&UWSSession::on_accept, self)
        );
    });
}

void UWSSession::send_http_error() {
    http::response<http::string_body> res{ http::status::bad_request, m_req.version() };
    res.set(http::field::server, "Boost.Beast");
    res.set(http::field::content_type, "text/html");
    res.keep_alive(false);
    res.body() = "This service requires WebSocket";
    res.prepare_payload();

    http::async_write(
        m_ws.next_layer(),
        res,
        [self = shared_from_this()](beast::error_code ec, std::size_t) {
            self->m_ws.next_layer().shutdown(tcp::socket::shutdown_both, ec);
        }
    );
}

void UWSSession::on_accept(beast::error_code ec) {
    if (ec) {
        std::cerr << "[WSSession " << id() << "] accept error: " << ec.message() << "\n";
        m_server.unregister_session(shared_from_this());
        return;
    }

    // Проверка, что m_req валиден — можно проверить target() на пустоту
    if (m_req.target().empty()) {
        std::cerr << "[WSSession " << id() << "] HTTP request target is empty, using default room\n";
        m_room_id = "default";
    }
    else {
        std::string target = std::string(m_req.target());
        if (!target.empty() && target.front() == '/') {
            m_room_id = target.substr(1);
        }
        else {
            m_room_id = target; // если нет начального '/', возьмем как есть
        }
    }

    std::cout << "[WSSession " << id() << "] Websocket accepted, room: " << m_room_id << "\n";

    // Регистрируем сессию в комнате
    m_server.join_room(m_room_id, shared_from_this());

    m_http_buffer.consume(m_http_buffer.size());

    // Начинаем читать сообщения от клиента
    do_read();
}

void UWSSession::do_read() {
    std::cout << "[WSSession " << id() << "] do_read() called\n";

    m_ws.async_read(m_ws_buffer,
        boost::asio::bind_executor(
            m_strand,
            [self = shared_from_this()](beast::error_code ec, std::size_t bytes_transferred) {
                self->on_read(ec, bytes_transferred);
            }
        )
    );
}

void UWSSession::on_read(beast::error_code ec, std::size_t bytes_transferred) {
    std::cout << "[UWSSession " << id() << "] ON_READ called!\n";
    boost::ignore_unused(bytes_transferred);

    if (ec == websocket::error::closed) {
        std::cout << "[WSSession " << id() << "] closed by client\n";
        m_closed = true;
        m_server.leave_room(m_room_id, shared_from_this());
        m_server.unregister_session(shared_from_this());
        return;
    }

    if (ec) {
        std::cerr << "[WSSession " << id() << "] read error: " << ec.message() << "\n";
        m_closed = true;
        m_server.leave_room(m_room_id, shared_from_this());
        m_server.unregister_session(shared_from_this());
        return;
    }

    std::string message = beast::buffers_to_string(m_ws_buffer.data());
    m_ws_buffer.consume(m_ws_buffer.size());
    std::cout << color::magenta << "[WSSession " << id() << "] Message Received (room " << m_room_id << "): "
        << (message.size() > 300 ? message.substr(0, 300) + "..." : message) << "\n" << color::reset;

    // Optional parse json for logging
    try {
        auto parsed = json::parse(message);
        if (parsed.is_object() && parsed.contains("type")) {
            try {
                auto t = parsed.at("type").get<std::string>();
                std::cout << color::bg_magenta << "[WSSession " << id() << "] message type: " << t 
                          << "; JSON: " << parsed << "\n" << color::reset;
            }
            catch (...) {}
        }
    }
    catch (const std::exception& e) {
        std::cerr << color::red << "[WSSession " << id() << "] json parse error: " << e.what() 
                  << " (message will still be broadcast)\n" << color::reset;
    }

    // Broadcast inside room
    m_server.on_client_message(m_room_id, message, shared_from_this());

    do_read();
}

void UWSSession::send_text(std::string const& message) {
    if (m_closed.load()) return;

    // Постим в strand, чтобы избежать гонок
    boost::asio::post(m_strand, [self = shared_from_this(), message]() {
        bool write_in_progress = !self->m_write_queue.empty();
        self->m_write_queue.push_back(message);
        if (!write_in_progress) {
            self->do_write();
        }
    });
}

void UWSSession::do_write() {
    std::lock_guard<std::mutex> lock(m_write_mutex);
    if (m_write_queue.empty()) return;

    auto const& msg = m_write_queue.front();
    m_ws.text(true);
    m_ws.async_write(
        asio::buffer(msg),
        boost::asio::bind_executor(
            m_strand,
            beast::bind_front_handler(&UWSSession::on_write, shared_from_this())
        )
    );
}

void UWSSession::on_write(beast::error_code ec, std::size_t bytes_transferred) {
    boost::ignore_unused(bytes_transferred);
    if (ec) {
        std::cerr << color::red << "[WSSession " << id() << "] write error: " 
                  << ec.message() << color::reset << std::endl;
        m_closed = true;
        m_server.leave_room(m_room_id, shared_from_this());
        m_server.unregister_session(shared_from_this());
        return;
    }

    std::lock_guard<std::mutex> lock(m_write_mutex);
    if (!m_write_queue.empty()) {
        m_write_queue.pop_front();
    }

    if (!m_write_queue.empty()) {
        do_write();
    }
}

void UWSSession::close() {
    if (m_closed.exchange(true)) return;
    beast::error_code ec;
    m_ws.close(websocket::close_code::normal, ec);
    if (ec) {
        std::cerr << "[WSSession] " << id() << "] close error: " << ec.message() << "\n";
    }
    m_server.leave_room(m_room_id, shared_from_this());
    m_server.unregister_session(shared_from_this());
}

std::string UWSSession::id() const {
    std::ostringstream ss;
    ss << static_cast<const void*>(this);
    return ss.str();
}

// ---------------- USignalingServer ----------------

USignalingServer::USignalingServer(asio::io_context& ioc)
    : m_ioc(ioc)
    , m_acceptor(ioc)
    , m_running(false)
{
}

void USignalingServer::run() {
    beast::error_code ec;

    m_acceptor.open(m_endpoint.protocol(), ec);
    if (ec) {
        std::cerr << color::red << "[USignalingServer] Server opened: " << ec.message() << color::reset << "\n";
        return;
    }

    m_acceptor.set_option(asio::socket_base::reuse_address(true), ec);
    if (ec) {
        std::cerr << color::red << "[USignalingServer] Server set_option: " << ec.message() << color::reset << "\n";
        return;
    }

    m_acceptor.bind(m_endpoint, ec);
    if (ec) {
        std::cerr << color::red << "[USignalingServer] Server binds: " << ec.message() << color::reset << "\n";
        return;
    }

    m_acceptor.listen(asio::socket_base::max_listen_connections, ec);
    if (ec) {
        std::cerr << color::red << "[USignalingServer] Server listening: " << ec.message() << color::reset << "\n";
        return;
    }

    std::cout << "[USignalingServer] Listening on " << m_endpoint.address().to_string() << ":" << m_endpoint.port() << "\n";

    do_accept();
}

bool USignalingServer::start(const std::string& ip, int port) {
    boost::system::error_code ec;

    // Определяем адрес
    boost::asio::ip::address addr;
    if (ip == "0.0.0.0") {
        addr = boost::asio::ip::address_v4::any();
    }
    else {
        addr = boost::asio::ip::make_address(ip, ec);
    }

    if (ec) {
        std::cerr << color::red << "[USignalingServer] Invalid IP: " << ec.message() << color::reset << "\n";
        return false;
    }

    m_endpoint = tcp::endpoint(addr, port);

    m_acceptor.open(m_endpoint.protocol(), ec);
    if (ec) {
        std::cerr << color::red << "[USignalingServer] Server opened: " << ec.message() << color::reset << "\n";
        return false;
    }

    m_acceptor.set_option(asio::socket_base::reuse_address(true), ec);
    if (ec) {
        std::cerr << color::red << "[USignalingServer] Server set_option: " << ec.message() << color::reset << "\n";
        return false;
    }

    m_acceptor.bind(m_endpoint, ec);
    if (ec) {
        std::cerr << color::red << "[USignalingServer] Server binds: " << ec.message() << color::reset << "\n";
        return false;
    }

    m_acceptor.listen(asio::socket_base::max_listen_connections, ec);
    if (ec) {
        std::cerr << color::red << "[USignalingServer] Server listening: " << ec.message() << color::reset << "\n";
        return false;
    }

    do_accept();

    std::cout << color::green << "[USignalingServer] Listening on " << m_endpoint.address().to_string()
              << ":" << m_endpoint.port() << color::reset << std::endl;

    return true;
}

void USignalingServer::stop() {
    if (!m_running) return;

    m_running = false;
    m_acceptor.close();

    std::cout << "[USignalingServer] Server stopped!\n";
}

void USignalingServer::do_accept() {
    m_acceptor.async_accept(
        asio::make_strand(m_ioc),
        [self = shared_from_this()](beast::error_code ec, tcp::socket socket) {
            if (ec) {
                std::cerr << "Accept error: " << ec.message() << "\n";
            }
            else {
                socket.set_option(boost::asio::socket_base::reuse_address(true));
                socket.set_option(boost::asio::ip::tcp::no_delay(true));

                auto session = std::make_shared<UWSSession>(std::move(socket), *self, self->m_ioc);
                self->register_session(session);
                session->start();
            }
            self->do_accept();
        }
    );
}

void USignalingServer::register_session(session_ptr s) {
    std::lock_guard<std::mutex> lock(m_sessions_mutex);
    m_sessions.insert(s);
    std::cout << "[USignalingServer] session registered: " << s->id()
        << " (total: " << m_sessions.size() << ")\n";
}

void USignalingServer::unregister_session(session_ptr s) {
    std::lock_guard<std::mutex> lock(m_sessions_mutex);
    m_sessions.erase(s);
    std::cout << "[USignalingServer] session unregistered: " << s->id()
        << " (total: " << m_sessions.size() << ")\n";
}

void USignalingServer::register_room_camera(std::shared_ptr<UCamera> camera) {
    // Установка камеры 
    std::string room = camera->get_name();
    {
        std::lock_guard lock(m_cameras_mutex);
        m_cameras[room] = camera;
    }
    // Установка рассылки на все сессии в комнате
    camera->set_signaling_callback(
        [this, room](const std::string message) {
            this->broadcast_to_room(room, message, nullptr);
        }
    );
    std::cout << color::cyan << "[USignalingServer] Camera " << room << " registred at server!\n" << color::reset;
}

void USignalingServer::unregister_room_camera(const std::string& camera_name) {
    std::lock_guard lock(m_cameras_mutex);
    auto camera = m_cameras.find(camera_name);
    if (camera == m_cameras.end()) {
        std::cout << color::red << "[USignalingServer] Error in unregister camera: camera " 
                  << camera_name << " not found!" << color::reset << std::endl;
        return;
    }
    // Уничтожаем колбэк и убираем камеру из сигналинг сервера
    camera->second->set_signaling_callback(nullptr);
    m_cameras.erase(camera_name);
}

void USignalingServer::join_room(std::string const& room_id, session_ptr session) {
    // Добавление сессии в комнату
    {
        std::lock_guard<std::mutex> lock(m_rooms_mutex);
        m_rooms[room_id].insert(session);
        std::cout << "[USignalingServer] Session " << session->id() << " joined room " << room_id
            << " (room size: " << m_rooms[room_id].size() << ")\n";
    }
}

void USignalingServer::leave_room(std::string const& room_id, session_ptr s) {
    std::lock_guard<std::mutex> lock(m_rooms_mutex);
    auto it = m_rooms.find(room_id);
    if (it != m_rooms.end()) {
        it->second.erase(s);
        std::cout << "[Server] session " << s->id() << " left room " << room_id
            << " (room size: " << it->second.size() << ")\n";
        if (it->second.empty()) {
            m_rooms.erase(it);
            std::cout << "[Server] room " << room_id << " removed (empty)\n";
        }
    }
}

void USignalingServer::on_client_message(const std::string& room_id, const std::string& msg, session_ptr sender) {
    // Найти камеру
    std::shared_ptr<UCamera> camera;
    {
        std::lock_guard lock(m_cameras_mutex);
        auto it = m_cameras.find(room_id);
        if (it != m_cameras.end())
            camera = it->second;
    }
    if (camera) {
        camera->on_signaling_message(msg);
    }
}

void USignalingServer::broadcast_to_room(std::string const& room_id, std::string const& msg, session_ptr exclude) {
    std::lock_guard<std::mutex> lock(m_rooms_mutex);
    auto it = m_rooms.find(room_id);
    if (it == m_rooms.end()) return;

    for (auto const& session : it->second) {
        if (session && session != exclude) {
            session->send_text(msg);
        }
    }
}

} // namespace neural
} // namespace varan
