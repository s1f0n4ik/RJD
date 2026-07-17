#pragma once

#include <string>
#include <vector>
#include <mutex>
#include <cstdint>

#include <boost/json.hpp>

#include "gateway/message.h"

namespace varan {
    namespace gateway {

        // Общая таблица соответствий, единая для всего шлюза и всех модулей любой
        // интеграции. Нейросеть отдаёт имена (cls "person", scls "human") и строковый
        // camera_id, а протоколы стороны заказчика требуют числовые id: тип
        // обнаружения 1..8, класс опасности 1..4, номер камеры 1..2. Таблица —
        // единственное место, где это соответствие задаётся; настраивается один раз
        // и применяется везде, где нужны числовые id (сейчас CAN, дальше остальные).
        //
        // Разрешение идёт по приоритету: правило конкретного класса перекрывает
        // правило суперкласса, незаданные поля наследуются от суперкласса, затем от
        // значений по умолчанию. Так набор классов можно уточнять точечно, не ломая
        // общее правило группы.
        class UTaxonomy {
        public:
            // Правило для класса или суперкласса. type/danger == 0 означает
            // "не задано" — поле берётся с более общего уровня.
            struct FRule {
                std::string key;    // имя класса нейросети (cls) или суперкласса (scls)
                std::string title;  // читаемое название для страницы
                int type = 0;       // тип обнаружения 1..8
                int danger = 0;     // класс опасности 1..4
            };

            struct FCamera {
                std::string key;    // camera_id, каким его шлёт media-center
                std::string title;  // читаемое название для страницы
                int id = 0;         // номер камеры в протоколе 1..2
            };

            // Итог разрешения одного обнаружения в числа протокола.
            struct FResolved {
                int type = 0;
                int danger = 0;
                std::string type_title;
                std::string danger_title;
            };

            UTaxonomy();

            // Числа протокола для обнаружения. Никогда не отдаёт 0: незаданное
            // подставляется из значений по умолчанию.
            FResolved resolve(const FDetection& det) const;

            // Номер камеры по строковому camera_id. 0 — соответствия нет.
            int resolve_camera(const std::string& camera_id) const;

            // Полная таблица для страницы: словари типов и классов опасности
            // (фиксированные, из протокола) плюс настраиваемые правила.
            boost::json::object to_json() const;

            // Частичное обновление: присутствующая секция заменяется целиком,
            // отсутствующая остаётся как была.
            bool apply_json(const boost::json::object& patch, std::string& err);

            // Читаемые названия словарей протокола — их же показывает страница.
            static std::string type_title(int type);
            static std::string danger_title(int danger);

        private:
            // Ищет правило по ключу без учёта регистра. nullptr, если правила нет.
            static const FRule* find(const std::vector<FRule>& rules, const std::string& key);
            static bool parse_rules(const boost::json::value& v, std::vector<FRule>& out, std::string& err);
            static bool parse_cameras(const boost::json::value& v, std::vector<FCamera>& out, std::string& err);

        private:
            mutable std::mutex m_mutex;

            std::vector<FRule> m_classes;        // приоритет над суперклассами
            std::vector<FRule> m_superclasses;
            std::vector<FCamera> m_cameras;

            // Куда падает обнаружение, для которого правил не нашлось:
            // "специфические предметы РСМ" и "информация (нет опасности)".
            int m_default_type = 8;
            int m_default_danger = 1;
        };

    } // namespace gateway
} // namespace varan
