#include "gateway/core/gateway.h"
#include "gateway/utility/log.h"

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

    // CAN: базовый запуск. Остальное (PGN, приоритет, период) правится по REST.
    config.can.mode = arg(argc, argv, "--can-mode", config.can.mode);
    config.can.iface = arg(argc, argv, "--can-iface", config.can.iface);
    config.can.device = arg(argc, argv, "--can-device", config.can.device);
    config.can.bitrate = std::stoi(arg(argc, argv, "--can-bitrate", std::to_string(config.can.bitrate)));
    // Адреса задаются шестнадцатеричными, как в описании протокола (0x71, 0x61).
    config.can.tx_detections.addr = std::stoi(arg(argc, argv, "--can-src", "0x71"), nullptr, 0);
    const int peer = std::stoi(arg(argc, argv, "--can-peer", "0x61"), nullptr, 0);
    config.can.rx_gps.addr = peer;
    config.can.rx_time.addr = peer;
    config.can.enabled = arg(argc, argv, "--can-enabled", "1") != "0";

    // Файл с сохранёнными настройками. Пусто — сохранение выключено (совместимо
    // с запуском без тома). В docker передаётся путь на смонтированном томе.
    config.state_file = arg(argc, argv, "--state-file", "");

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
