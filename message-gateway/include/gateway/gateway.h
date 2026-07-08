#pragma once

#include <memory>
#include <mutex>
#include <atomic>
#include <thread>
#include <cstdint>

#include <boost/asio.hpp>

#include "gateway/config.h"
#include "gateway/codec.h"
#include "gateway/message.h"
#include "gateway/transport.h"
#include "gateway/http-server.h"
#include "gateway/frame-sink.h"

namespace varan {
    namespace gateway {

        class UGrpcIngress;

        // Ядро сервиса: связывает ingress, реестр кодеков и транспорты.
        // Кадры приходят по gRPC (submit_frame), настройка — по REST. Gateway
        // проверяет поддержку версии, кодирует под протокол и шлёт в транспорт.
        class UGateway : public IFrameSink {
        public:
            explicit UGateway(FGatewayConfig config);
            ~UGateway() override;

            // Блокирующий запуск: поднимает REST, gRPC и WS, крутит io_context'ы.
            void run();
            void stop();

            // Приём кадра (из gRPC-ингресса): проверка версии, кодирование, отправка.
            FSubmitResult submit_frame(const FFrameMessage& msg) override;

        private:
            void setup_codecs();
            void setup_routes();
            void start_heartbeat();

            URouter::FResponse handle_health(const URouter::FRequest& req);
            URouter::FResponse handle_get_config(const URouter::FRequest& req);
            URouter::FResponse handle_put_ws_config(const URouter::FRequest& req);
            URouter::FResponse handle_ws_connect(const URouter::FRequest& req);
            URouter::FResponse handle_ws_disconnect(const URouter::FRequest& req);
            URouter::FResponse handle_ws_status(const URouter::FRequest& req);
            URouter::FResponse handle_versions(const URouter::FRequest& req);

            static std::int64_t now_ms();

        private:
            FGatewayConfig m_config;
            mutable std::mutex m_config_mutex;

            UCodecRegistry m_registry;

            boost::asio::io_context m_http_ioc{ 1 };
            boost::asio::io_context m_ws_ioc{ 1 };

            std::shared_ptr<URouter> m_router;
            std::shared_ptr<UWsTransport> m_ws;
            boost::asio::steady_timer m_heartbeat_timer{ m_ws_ioc };

            std::unique_ptr<UGrpcIngress> m_grpc;

            std::atomic<std::int64_t> m_last_send_ms{ 0 };
            std::atomic_bool m_running{ false };
            std::thread m_ws_thread;
        };

    } // namespace gateway
} // namespace varan
