#pragma once

#include <memory>
#include <mutex>
#include <atomic>
#include <chrono>
#include <cstdint>

#include <boost/asio.hpp>

#include "gateway/integration.h"
#include "gateway/codec.h"
#include "gateway/transport.h"
#include "gateway/stats.h"
#include "gateway/config.h"

namespace varan {
    namespace gateway {

        // Серверное время в миллисекундах Unix. Общая точка для всех, кому нужен
        // момент "сейчас" внутри сервиса.
        inline std::int64_t now_ms() {
            return std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count();
        }

        // Интеграция РСМ-2000: передача кадров стороне КАУС по WebSocket.
        // Владеет кодеком протокола, WebSocket-транспортом, heartbeat'ом и
        // статистикой. Первая (и пока единственная) реализация IIntegration.
        class URsm2000Integration : public IIntegration {
        public:
            URsm2000Integration(boost::asio::io_context& ioc, FWsConfig ws, int heartbeat_sec);

            std::string id() const override { return "rsm-2000"; }
            std::string title() const override { return "РСМ-2000"; }
            std::string description() const override {
                return "Передача обнаружений в АС КРСПС по протоколу v1 через WebSocket с heartbeat.";
            }
            std::string transport() const override { return "websocket"; }

            void start() override;
            void stop() override;
            bool connected() const override;

            FSubmitResult handle_frame(const FFrameMessage& msg) override;

            std::vector<int> protocol_versions() const override {
                return m_registry.versions();
            }

            boost::json::object config_json() const override;
            boost::json::object status_json() const override;
            bool apply_config(const boost::json::object& patch, std::string& err) override;

        private:
            void start_heartbeat();
            // Единственный модуль конфигурации РСМ-2000 — доставка по WebSocket.
            // Возвращает его полное состояние (настройки, соединение, статистика).
            boost::json::object module_json() const;

        private:
            boost::asio::io_context& m_ioc;
            UCodecRegistry m_registry;
            std::shared_ptr<UWsTransport> m_ws;
            boost::asio::steady_timer m_heartbeat_timer;

            std::atomic<int> m_heartbeat_sec;
            std::atomic<std::int64_t> m_last_send_ms{ 0 };
            std::atomic_bool m_active{ false };

            UStats m_stats;
        };

    } // namespace gateway
} // namespace varan
