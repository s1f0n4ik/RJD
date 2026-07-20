#pragma once

#include <string>
#include <vector>
#include <memory>
#include <cstdint>

#include <boost/json.hpp>

#include "gateway/core/message.h"
#include "gateway/core/frame-sink.h"
#include "gateway/core/module.h"

namespace varan {
    namespace gateway {

        // Одна "конфигурация" интеграции с АС КРСПС. Слушает кадры из gRPC-ингресса
        // (через UGateway) и раздаёт их своим модулям доставки. Сейчас реализована
        // РСМ-2000 с двумя модулями: WebSocket (кадр с изображением в КАУС) и CAN
        // (обнаружения на шину изделия). Modbus и прочие добавляются новой
        // реализацией IIntegration без изменения остального сервиса.
        //
        // Интеграция сама владеет набором модулей; каждый модуль владеет своим
        // транспортом, кодированием, периодикой и статистикой.
        class IIntegration {
        public:
            virtual ~IIntegration() = default;

            // Стабильный идентификатор (для выбора по REST), напр. "rsm-2000".
            virtual std::string id() const = 0;
            // Человекочитаемое имя для UI, напр. "РСМ-2000".
            virtual std::string title() const = 0;
            // Пояснение для карточки конфигурации в UI.
            virtual std::string description() const = 0;

            // Модули конфигурации. Через них REST адресует настройки и подключение
            // конкретного канала, не зная, какие именно каналы есть у интеграции.
            virtual std::vector<std::shared_ptr<IModule>> modules() const = 0;
            // Модуль по id ("websocket" / "can"); nullptr, если такого нет.
            virtual std::shared_ptr<IModule> find_module(const std::string& id) const = 0;

            // Поднять/погасить все модули. Активна одновременно только выбранная
            // интеграция.
            virtual void start() = 0;
            virtual void stop() = 0;
            // true, если жив хотя бы один модуль: у конфигурации несколько каналов,
            // и молчание одного из них не означает, что связи нет вообще.
            virtual bool connected() const = 0;

            // Раздать кадр модулям и свести их ответы в один результат.
            virtual FSubmitResult handle_frame(const FFrameMessage& msg) = 0;

            // Версии протокола, которые интеграция умеет кодировать (объединение
            // по модулям).
            virtual std::vector<int> protocol_versions() const = 0;

            // Конфигурация интеграции для REST: перечень модулей с их настройками.
            virtual boost::json::object config_json() const = 0;

            // Полный снимок состояния: соединение + счётчики + последние сообщения
            // по каждому модулю.
            virtual boost::json::object status_json() const = 0;
        };

    } // namespace gateway
} // namespace varan
