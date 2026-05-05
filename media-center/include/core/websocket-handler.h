#pragma once
#include <thread>
#include <optional>
#include <functional>

#include <boost/json.hpp>

#include "websocket-client.h"
#include "logger.h"

namespace varan {

	class UWebSocketHandler {
	public:
		UWebSocketHandler() = delete;
		UWebSocketHandler(
			const std::string& ip_address,
			const std::string& port,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::TRACE,
			std::optional<std::string> debug_name = std::nullopt
		);

		virtual ~UWebSocketHandler();

	protected:

		void start_websocket_client(const std::string& url, const std::string& client_name);

		void stop_websocket_client();

		virtual void send_message(const std::string& msg);

		virtual void send_binary(const std::string & message);

		virtual void on_signaling_message(const std::string& msg) = 0;

	protected:
		std::string m_ip_adress;
		std::string m_port;

		std::shared_ptr<neural::UWebSocketClient> m_websocket_client;
		boost::asio::io_context m_io_context;

		std::thread m_websocket_thread;
		std::mutex m_signal_mutex;

		ULogger m_logger;
	};

} // varan