#include "gateway/gateway.h"
#include "gateway/log.h"

#include <boost/asio/signal_set.hpp>

#include <string>
#include <cstdlib>

using namespace varan::gateway;

namespace {

    // Простейший разбор аргументов вида --key value. Только для базового запуска;
    // основная конфигурация делается в рантайне через REST.
    std::string arg(int argc, char** argv, const std::string& key, const std::string& def) {
        for (int i = 1; i + 1 < argc; ++i) {
            if (key == argv[i]) {
                return argv[i + 1];
            }
        }
        return def;
    }

} // namespace

int main(int argc, char** argv) {
    FGatewayConfig config;
    config.rest_port = static_cast<uint16_t>(std::stoi(arg(argc, argv, "--rest-port", "9090")));
    config.grpc_port = static_cast<uint16_t>(std::stoi(arg(argc, argv, "--grpc-port", "50051")));
    config.ws.host = arg(argc, argv, "--ws-host", config.ws.host);
    config.ws.port = arg(argc, argv, "--ws-port", config.ws.port);
    config.ws.target = arg(argc, argv, "--ws-target", config.ws.target);
    config.heartbeat_sec = std::stoi(arg(argc, argv, "--heartbeat", "5"));

    UGateway gateway(config);

    // Отдельный io_context под сигналы, чтобы корректно гасить сервис.
    boost::asio::io_context signal_ioc;
    boost::asio::signal_set signals(signal_ioc, SIGINT, SIGTERM);
    signals.async_wait([&](const boost::system::error_code&, int) {
        ULog::info("main", "Shutdown signal received");
        gateway.stop();
    });
    std::thread signal_thread([&] { signal_ioc.run(); });

    ULog::info("main", "message-gateway starting");
    gateway.run();

    signal_ioc.stop();
    if (signal_thread.joinable()) {
        signal_thread.join();
    }
    return 0;
}
