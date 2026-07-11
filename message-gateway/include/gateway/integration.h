#pragma once

#include <string>
#include <vector>
#include <cstdint>

#include <boost/json.hpp>

#include "gateway/message.h"
#include "gateway/frame-sink.h"

namespace varan {
    namespace gateway {

        // Одна "конфигурация" интеграции с АС КРСПС. Слушает кадры из gRPC-ингресса
        // (через UGateway) и применяет свою логику доставки. Сейчас реализована
        // РСМ-2000 (передача по WebSocket); CAN/Modbus и прочие добавляются новой
        // реализацией IIntegration без изменения остального сервиса.
        //
        // Интеграция сама владеет транспортом, кодированием сообщения, heartbeat'ом
        // и статистикой — снаружи виден только этот контракт.
        class IIntegration {
        public:
            virtual ~IIntegration() = default;

            // Стабильный идентификатор (для выбора по REST), напр. "rsm-2000".
            virtual std::string id() const = 0;
            // Человекочитаемое имя для UI, напр. "РСМ-2000".
            virtual std::string title() const = 0;
            // Пояснение для карточки конфигурации в UI.
            virtual std::string description() const = 0;
            // Тип транспорта: "websocket" / "can" / "modbus".
            virtual std::string transport() const = 0;

            // Поднять/погасить канал (транспорт, heartbeat). Активна одновременно
            // только выбранная интеграция.
            virtual void start() = 0;
            virtual void stop() = 0;
            virtual bool connected() const = 0;

            // Применить логику конфигурации к кадру: кодирование + доставка.
            // Ведёт свою статистику. Транспортно-независимый результат.
            virtual FSubmitResult handle_frame(const FFrameMessage& msg) = 0;

            // Версии протокола, которые интеграция умеет кодировать.
            virtual std::vector<int> protocol_versions() const = 0;

            // Текущая конфигурация интеграции для REST (host/port/target и т.п.).
            virtual boost::json::object config_json() const = 0;

            // Полный снимок состояния: соединение + счётчики + последние сообщения.
            virtual boost::json::object status_json() const = 0;

            // Частичное обновление настроек. Каждая интеграция трактует поля сама
            // (РСМ-2000 понимает host/port/target/enabled). false + err при ошибке.
            virtual bool apply_config(const boost::json::object& patch, std::string& err) = 0;
        };

    } // namespace gateway
} // namespace varan
