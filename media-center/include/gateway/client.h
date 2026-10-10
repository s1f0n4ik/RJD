#pragma once

#include <string>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>

#include "gateway/frame.h"
#include "logger.h"

namespace varan {
namespace gateway {

    // Параметры подключения к message-gateway. enabled=false — время и GPS со шлюза не берутся.
    struct FGatewayConfig {
        bool enabled = false;
        std::string host;
        std::string port;
    };

    // Клиент message-gateway: время и GPS через GetTime раз в 10 с; обнаружения в шлюз шлёт мастер
    class UGatewayClient {
    public:
        UGatewayClient(FGatewayConfig config,
            ULogger::ELoggerLevel level = ULogger::ELoggerLevel::INFO);
        ~UGatewayClient();

        UGatewayClient(const UGatewayClient&) = delete;
        UGatewayClient& operator=(const UGatewayClient&) = delete;

        void start();
        void stop();

        // Регистрирует получателя снимков времени/GPS (см. FGatewayTimeCallback).
        // Вызывать до start() — набор потоков ещё не запущен, гонок нет.
        void set_time_callback(FGatewayTimeCallback callback);

    private:
        void time_sync_loop();

        std::string m_host;
        std::string m_port;
        ULogger m_logger;

        std::atomic_bool m_running{ false };

        FGatewayTimeCallback m_time_callback;
        std::thread m_time_thread;
        std::mutex m_time_mutex;
        std::condition_variable m_time_cv;
    };

} // namespace gateway
} // namespace varan