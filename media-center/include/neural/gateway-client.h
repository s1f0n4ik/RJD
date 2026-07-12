#pragma once

#include <string>
#include <deque>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <cstddef>

#include "neural/gateway-frame.h"
#include "logger.h"

namespace varan {
namespace neural {

    // Параметры подключения к message-gateway. enabled=false — интеграция со
    // шлюзом выключена (кадры в шлюз не отправляются).
    struct FGatewayConfig {
        bool enabled = false;
        std::string host;
        std::string port;
    };

    // Клиент ingress-сервиса message-gateway (gRPC FrameIngress, StreamFrames).
    // Держит одно соединение в фоновом потоке и переподключается с backoff.
    // send() не блокирует поток нейросети: кадр кладётся в ограниченную очередь,
    // при переполнении/отсутствии связи отбрасывается самый старый.
    //
    // gRPC-типы намеренно не выносятся в заголовок — канал и stub живут внутри
    // worker_loop() в единице трансляции gateway-client.cpp.
    class UGatewayClient {
    public:
        UGatewayClient(FGatewayConfig config,
            ULogger::ELoggerLevel level = ULogger::ELoggerLevel::INFO);
        ~UGatewayClient();

        UGatewayClient(const UGatewayClient&) = delete;
        UGatewayClient& operator=(const UGatewayClient&) = delete;

        void start();
        void stop();

        bool connected() const { return m_connected.load(); }

        void send(FGatewayFrame frame);

        // Регистрирует получателя снимков времени/GPS (см. FGatewayTimeCallback).
        // Вызывать до start() — набор потоков ещё не запущен, гонок нет.
        void set_time_callback(FGatewayTimeCallback callback);

    private:
        void worker_loop();
        void time_sync_loop();

        std::string m_host;
        std::string m_port;
        ULogger m_logger;

        std::deque<FGatewayFrame> m_queue;
        std::mutex m_mutex;
        std::condition_variable m_cv;
        std::size_t m_max_queue = 12;

        std::thread m_thread;
        std::atomic_bool m_running{ false };
        std::atomic_bool m_connected{ false };

        // Опрос времени/GPS — отдельный поток и соединение, независимое от
        // потока стрима кадров (лёгкий unary-вызов раз в 10с).
        FGatewayTimeCallback m_time_callback;
        std::thread m_time_thread;
        std::mutex m_time_mutex;
        std::condition_variable m_time_cv;
    };

} // namespace neural
} // namespace varan