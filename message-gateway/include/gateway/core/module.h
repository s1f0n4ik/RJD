#pragma once

#include <string>
#include <vector>

#include <boost/json.hpp>

#include "gateway/core/message.h"
#include "gateway/core/frame-sink.h"

namespace varan {
    namespace gateway {

        // Один канал доставки внутри интеграции: свой транспорт, свои настройки,
        // своё соединение и своя статистика. Интеграция — это набор модулей:
        // у РСМ-2000 их два (WebSocket в КАУС и CAN на шину изделия), и кадр
        // уходит в оба одновременно.
        //
        // Страница КРСПС рисует каждый модуль отдельным разделом, поэтому to_json()
        // отдаёт законченный снимок: настройки + connection + stats.
        class IModule {
        public:
            virtual ~IModule() = default;

            // Стабильный идентификатор внутри интеграции: "websocket" / "can".
            // По нему же адресуются REST-ручки настройки и подключения.
            virtual std::string id() const = 0;
            virtual std::string title() const = 0;
            // Тип транспорта: "websocket" / "can" / "modbus".
            virtual std::string transport() const = 0;

            virtual void start() = 0;
            virtual void stop() = 0;
            virtual bool connected() const = 0;

            // Кодирование + доставка кадра своим транспортом.
            virtual FSubmitResult handle_frame(const FFrameMessage& msg) = 0;

            virtual std::vector<int> protocol_versions() const = 0;

            // Полный снимок модуля для страницы и для /status.
            virtual boost::json::object to_json() const = 0;

            // Только настройки модуля, без соединения и статистики. Ровно то, что
            // принимает apply_config, — чтобы сохранить на диск и восстановить
            // после перезапуска. Полный to_json для этого не годится: в нём живёт
            // состояние, которое сохранять нельзя.
            virtual boost::json::object config_snapshot() const = 0;

            // Частичное обновление настроек модуля. false + err при ошибке.
            virtual bool apply_config(const boost::json::object& patch, std::string& err) = 0;
        };

    } // namespace gateway
} // namespace varan
