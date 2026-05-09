#include "core/websocket-handler.h"

#include "signaling_definers.h"

namespace varan {

	UWebSocketHandler::UWebSocketHandler(
		const std::string& ip_address,
		const std::string& port,
		ULogger::ELoggerLevel level,
		std::optional<std::string> debug_name
	) 
		: m_ip_adress(ip_address)
		, m_port(port)
		, m_logger(debug_name ? debug_name.value() : "WebSocket", level)
	{}

	UWebSocketHandler::~UWebSocketHandler()
	{
		
	}

	void UWebSocketHandler::start_websocket_client(const std::string& url, const std::string& client_name)
	{
		if (!m_websocket_client) {
			m_websocket_client = std::make_unique<neural::UWebSocketClient>(m_io_context, m_ip_adress, m_port, url, client_name);
		}

		m_websocket_client->set_message_callback(
			[this](const std::string& message) {
				this->on_signaling_message(message);
			}
		);

		m_websocket_thread = std::thread([this]() {
			try {
				m_websocket_client->run();

				m_io_context.run();
			}
			catch (std::exception& error) {
				m_logger.error("Websocket start error: " + std::string(error.what()));
			}
		});

		m_logger.info("Started websocket at " + m_ip_adress + ":" + m_port + ". Url: " + url);
	}

	void UWebSocketHandler::stop_websocket_client()
	{
		if (m_websocket_client) {
			m_websocket_client->stop();
		}

		m_io_context.stop();

		if (m_websocket_thread.joinable()) {
			m_websocket_thread.join();
		}

		m_websocket_client.reset();
	}

	void UWebSocketHandler::send_message(const std::string& message)
	{
		std::lock_guard lock(m_signal_mutex);
		if (m_websocket_client) {
			m_websocket_client->send(message, false);
		}
		else {
			m_logger.error("Cannot send message because websocket client is nullptr!");
		}
	}

	void UWebSocketHandler::send_binary(const std::string& message)
	{
		std::lock_guard lock(m_signal_mutex);
		if (m_websocket_client) {
			m_websocket_client->send(message, true);
		}
		else {
			m_logger.error("Cannot send message because websocket client is nullptr!");
		}
	}
}