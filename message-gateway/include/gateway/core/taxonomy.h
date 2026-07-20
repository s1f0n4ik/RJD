#pragma once

#include <string>
#include <vector>
#include <mutex>
#include <cstdint>

#include <boost/json.hpp>

#include "gateway/core/message.h"

namespace varan {
    namespace gateway {

        // Общая таблица соответствий, единая для всего шлюза и всех модулей любой
        // интеграции. Нейросеть отдаёт имена (cls "person", scls "human") и строковый
        // camera_id, а протоколы стороны заказчика требуют числовые id: тип
        // обнаружения 1..8, класс опасности 1..4, камеру — битом в байте.
        //
        // Два независимых раздела:
        //
        // 1. Таблицы классов и суперклассов — свои для каждой конфигурации
        //    нейросети (config_id). Имена классов задаются конфигом модели, в
        //    разных конфигурациях один и тот же "person" может значить разное,
        //    поэтому общей таблицы на все конфигурации быть не может. Если для
        //    пришедшей конфигурации таблицы нет, работает passthrough: числа
        //    берутся как есть из gRPC (тип = cid), без перевода имён.
        //
        // 2. Камеры — вне конфигураций: камера физическая, от модели не зависит.
        //    Каждой назначается бит в байте, поэтому в одном кадре видно сразу
        //    несколько камер, поймавших обнаружение.
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

            // Таблица одной конфигурации нейросети.
            struct FConfigTable {
                std::string id;     // config_id, каким его шлёт media-center
                std::string title;  // читаемое название для страницы
                std::vector<FRule> classes;       // приоритет над суперклассами
                std::vector<FRule> superclasses;
            };

            struct FCamera {
                std::string key;    // camera_id, каким его шлёт media-center
                std::string title;  // читаемое название для страницы
                int bit = 0;        // номер бита в байте камер, 1..8
            };

            // Итог разрешения одного обнаружения в числа протокола.
            struct FResolved {
                int type = 0;
                int danger = 0;
                std::string type_title;
                std::string danger_title;
                // true — таблицы для конфигурации не нашлось, числа взяты как
                // пришли. Модуль сообщает это на страницу, иначе непонятно,
                // почему типы совпадают с id классов модели.
                bool passthrough = false;
            };

            UTaxonomy();

            // Числа протокола для обнаружения из конфигурации config_id.
            // Никогда не отдаёт 0: незаданное подставляется из умолчаний.
            FResolved resolve(const std::string& config_id, const FDetection& det) const;

            // Номер бита камеры в байте (1..8). 0 — соответствия нет.
            int camera_bit(const std::string& camera_id) const;

            // Есть ли таблица под эту конфигурацию (иначе — passthrough).
            bool has_config(const std::string& config_id) const;

            // Полная таблица для страницы: словари типов и классов опасности
            // (фиксированные, из протокола) плюс настраиваемые разделы.
            boost::json::object to_json() const;

            // Частичное обновление: присутствующая секция заменяется целиком,
            // отсутствующая остаётся как была.
            bool apply_json(const boost::json::object& patch, std::string& err);

            // Читаемые названия словарей протокола — их же показывает страница.
            static std::string type_title(int type);
            static std::string danger_title(int danger);

        private:
            static const FRule* find(const std::vector<FRule>& rules, const std::string& key);
            const FConfigTable* find_config(const std::string& config_id) const;
            static bool parse_rules(const boost::json::value& v, std::vector<FRule>& out, std::string& err);
            static bool parse_configs(const boost::json::value& v, std::vector<FConfigTable>& out, std::string& err);
            static bool parse_cameras(const boost::json::value& v, std::vector<FCamera>& out, std::string& err);

        private:
            mutable std::mutex m_mutex;

            std::vector<FConfigTable> m_configs;  // пусто из коробки -> passthrough
            std::vector<FCamera> m_cameras;

            // Куда падает обнаружение, для которого правил не нашлось:
            // "специфические предметы РСМ" и "информация (нет опасности)".
            int m_default_type = 8;
            int m_default_danger = 1;
        };

    } // namespace gateway
} // namespace varan
