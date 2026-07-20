#pragma once

#include <string>
#include <memory>
#include <mutex>

#include <boost/asio.hpp>

#include "gateway/config.h"
#include "gateway/ws-client.h"
#include "gateway/log.h"

namespace varan {
    namespace gateway {

        // Общий контракт исходящего канала. Кодек отдаёт готовые байты, транспорт
        // только доставляет их. Добавить CAN/Modbus = новая реализация ITransport,
        // остальной сервис не меняется.
        class ITransport {
        public:
            virtual ~ITransport() = default;

            virtual std::string name() const = 0;
            virtual bool connected() const = 0;

            // payload уже закодирован под протокол; binary различает тип фрейма
            // там, где это имеет смысл (для WS: бинарный кадр против текстового).
            virtual void send(const std::string& payload, bool binary) = 0;
        };

        // WebSocket-транспорт поверх UWebSocketClient. Живёт на переданном
        // io_context (его крутит поток gateway).
        class UWsTransport : public ITransport {
        public:
            UWsTransport(boost::asio::io_context& ioc, FWsConfig config)
                : m_ioc(ioc)
                , m_config(std::move(config))
            {}

            std::string name() const override {
                return "websocket";
            }

            bool connected() const override {
                std::lock_guard<std::mutex> lock(m_mutex);
                return m_client && m_client->connected();
            }

            void send(const std::string& payload, bool binary) override {
                std::shared_ptr<UWebSocketClient> client;
                {
                    std::lock_guard<std::mutex> lock(m_mutex);
                    client = m_client;
                }
                if (client) {
                    client->send(payload, binary);
                }
            }

            FWsConfig config() const {
                std::lock_guard<std::mutex> lock(m_mutex);
                return m_config;
            }

            void connect() {
                std::lock_guard<std::mutex> lock(m_mutex);
                start_locked();
            }

            void disconnect() {
                std::lock_guard<std::mutex> lock(m_mutex);
                stop_locked();
            }

            // Применяет новую конфигурацию и переподключается, если включено.
            void reconfigure(const FWsConfig& config) {
                std::lock_guard<std::mutex> lock(m_mutex);
                stop_locked();
                m_config = config;
                start_locked();
            }

        private:
            void start_locked() {
                if (!m_config.enabled) {
                    ULog::info("transport:ws", "Disabled, not connecting");
                    return;
                }
                m_client = std::make_shared<UWebSocketClient>(
                    m_ioc, m_config.host, m_config.port, m_config.target, "kaus");
                m_client->run();
            }

            void stop_locked() {
                if (m_client) {
                    m_client->stop();
                    m_client.reset();
                }
            }

        private:
            boost::asio::io_context& m_ioc;
            mutable std::mutex m_mutex;
            FWsConfig m_config;
            std::shared_ptr<UWebSocketClient> m_client;
        };

    } // namespace gateway
} // namespace varan
