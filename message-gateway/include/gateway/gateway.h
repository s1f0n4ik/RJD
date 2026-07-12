#pragma once

#include <memory>
#include <mutex>
#include <atomic>
#include <thread>
#include <vector>
#include <cstdint>

#include <boost/asio.hpp>

#include "gateway/config.h"
#include "gateway/message.h"
#include "gateway/http-server.h"
#include "gateway/frame-sink.h"
#include "gateway/integration.h"
#include "gateway/timesource.h"

namespace varan {
    namespace gateway {

        class UGrpcIngress;

        // Ядро сервиса: реестр интеграций (конфигураций) + ingress + REST.
        // Кадры приходят по gRPC (submit_frame) и делегируются активной интеграции,
        // которая применяет свою логику доставки (РСМ-2000 — WebSocket). Настройка
        // и выбор конфигурации — по REST. Смена реализации (CAN/Modbus) = новая
        // интеграция, ядро не меняется.
        class UGateway : public IFrameSink {
        public:
            explicit UGateway(FGatewayConfig config);
            ~UGateway() override;

            // Блокирующий запуск: поднимает REST, gRPC и активную интеграцию.
            void run();
            void stop();

            // Приём кадра из gRPC-ингресса: делегирование активной интеграции.
            FSubmitResult submit_frame(const FFrameMessage& msg) override;

            // Точное время + GPS (для gRPC GetTime, зеркалирует REST /time).
            FTimeGpsSnapshot get_time_gps() const override;

        private:
            void setup_integrations();
            void setup_routes();

            std::shared_ptr<IIntegration> active() const;
            std::shared_ptr<IIntegration> find_integration(const std::string& id) const;

            URouter::FResponse handle_health(const URouter::FRequest& req);
            URouter::FResponse handle_list_integrations(const URouter::FRequest& req);
            URouter::FResponse handle_select_integration(const URouter::FRequest& req);
            URouter::FResponse handle_status(const URouter::FRequest& req);
            URouter::FResponse handle_get_config(const URouter::FRequest& req);
            URouter::FResponse handle_put_ws_config(const URouter::FRequest& req);
            URouter::FResponse handle_ws_connect(const URouter::FRequest& req);
            URouter::FResponse handle_ws_disconnect(const URouter::FRequest& req);
            URouter::FResponse handle_ws_status(const URouter::FRequest& req);
            URouter::FResponse handle_versions(const URouter::FRequest& req);
            URouter::FResponse handle_time(const URouter::FRequest& req);

        private:
            FGatewayConfig m_config;

            boost::asio::io_context m_http_ioc{ 1 };
            boost::asio::io_context m_ws_ioc{ 1 };

            std::shared_ptr<URouter> m_router;

            std::vector<std::shared_ptr<IIntegration>> m_integrations;
            std::shared_ptr<IIntegration> m_active;
            mutable std::mutex m_active_mutex;

            UTimeSource m_time;

            std::unique_ptr<UGrpcIngress> m_grpc;

            std::atomic_bool m_running{ false };
            std::thread m_ws_thread;
        };

    } // namespace gateway
} // namespace varan
