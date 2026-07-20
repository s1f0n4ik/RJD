#pragma once

#include <memory>
#include <atomic>
#include <cstdint>

#include <boost/asio.hpp>

#include "gateway/core/module.h"
#include "gateway/core/codec.h"
#include "gateway/modules/websocket/transport.h"
#include "gateway/core/stats.h"
#include "gateway/core/config.h"
#include "gateway/utility/clock.h"

namespace varan {
    namespace gateway {

        // Модуль доставки кадров по WebSocket (КАУС): кодек протокола + транспорт +
        // heartbeat при простое канала. Логика та же, что была в РСМ-2000 до
        // появления второго модуля, — переехала за IModule без изменений.
        class UWsModule : public IModule {
        public:
            UWsModule(boost::asio::io_context& ioc, FWsConfig config, int heartbeat_sec);

            std::string id() const override { return "websocket"; }
            std::string title() const override { return "WebSocket"; }
            std::string transport() const override { return "websocket"; }

            void start() override;
            void stop() override;
            bool connected() const override;

            FSubmitResult handle_frame(const FFrameMessage& msg) override;

            std::vector<int> protocol_versions() const override {
                return m_registry.versions();
            }

            boost::json::object to_json() const override;
            boost::json::object config_snapshot() const override;
            bool apply_config(const boost::json::object& patch, std::string& err) override;

        private:
            void start_heartbeat();

        private:
            boost::asio::io_context& m_ioc;
            UCodecRegistry m_registry;
            std::shared_ptr<UWsTransport> m_ws;
            boost::asio::steady_timer m_heartbeat_timer;

            std::atomic<int> m_heartbeat_sec;
            // Отправлять ли служебный heartbeat при простое канала. Таймер при этом
            // продолжает крутиться — просто пропускает отправку, — чтобы включение
            // тумблера не требовало пересоздавать таймер.
            std::atomic_bool m_heartbeat_enabled{ true };
            std::atomic<std::int64_t> m_last_send_ms{ 0 };
            std::atomic_bool m_active{ false };

            UStats m_stats;
        };

    } // namespace gateway
} // namespace varan
