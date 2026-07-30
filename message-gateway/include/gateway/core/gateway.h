#pragma once

#include <memory>
#include <mutex>
#include <atomic>
#include <thread>
#include <vector>
#include <cstdint>

#include <boost/asio.hpp>

#include "gateway/core/config.h"
#include "gateway/core/message.h"
#include "gateway/core/http-server.h"
#include "gateway/core/frame-sink.h"
#include "gateway/core/integration.h"
#include "gateway/core/timesource.h"
#include "gateway/core/taxonomy.h"
#include "gateway/core/store.h"

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

            // Восстановить настройки из файла после сборки интеграций (в
            // конструкторе, до запуска модулей). Сохранённое побеждает флаги
            // запуска — иначе перезапуск сбрасывал бы выбранный режим шины.
            void restore_state();
            // Записать текущие настройки всех интеграций и таблицу соответствий.
            // Зовётся после каждой удачной правки по REST.
            void persist_state();

            std::shared_ptr<IIntegration> active() const;
            std::shared_ptr<IIntegration> find_integration(const std::string& id) const;

            URouter::FResponse handle_health(const URouter::FRequest& req);
            URouter::FResponse handle_list_integrations(const URouter::FRequest& req);
            URouter::FResponse handle_select_integration(const URouter::FRequest& req);
            URouter::FResponse handle_status(const URouter::FRequest& req);
            URouter::FResponse handle_get_config(const URouter::FRequest& req);
            // Настройки конкретного модуля активной конфигурации. Роутер путей с
            // параметрами не умеет, поэтому id модуля приходит из замыкания.
            URouter::FResponse handle_put_module_config(const URouter::FRequest& req,
                const std::string& module_id);
            URouter::FResponse handle_module_connect(const URouter::FRequest& req, bool connect);
            URouter::FResponse handle_ws_connect(const URouter::FRequest& req);
            URouter::FResponse handle_ws_disconnect(const URouter::FRequest& req);
            URouter::FResponse handle_ws_status(const URouter::FRequest& req);
            URouter::FResponse handle_versions(const URouter::FRequest& req);
            URouter::FResponse handle_time(const URouter::FRequest& req);
            URouter::FResponse handle_put_time_config(const URouter::FRequest& req);
            URouter::FResponse handle_get_taxonomy(const URouter::FRequest& req);
            URouter::FResponse handle_put_taxonomy(const URouter::FRequest& req);
            URouter::FResponse handle_devices(const URouter::FRequest& req);

        private:
            FGatewayConfig m_config;

            boost::asio::io_context m_http_ioc{ 1 };
            boost::asio::io_context m_ws_ioc{ 1 };

            std::shared_ptr<URouter> m_router;

            std::vector<std::shared_ptr<IIntegration>> m_integrations;
            std::shared_ptr<IIntegration> m_active;
            mutable std::mutex m_active_mutex;

            // Общие для всего шлюза: таблица соответствий (её применяют модули всех
            // интеграций) и источник времени/GPS (его наполняет модуль CAN).
            // Живут здесь, а не внутри интеграции, потому что настраиваются один
            // раз и переживают переключение конфигурации.
            UTaxonomy m_taxonomy;
            UTimeSource m_time;

            // Файловое хранилище настроек: таблица соответствий, настройки
            // сообщений и подключений всех модулей. Переживает перезапуск.
            UStore m_store;

            std::unique_ptr<UGrpcIngress> m_grpc;

            std::atomic_bool m_running{ false };
            std::thread m_ws_thread;
        };

    } // namespace gateway
} // namespace varan
