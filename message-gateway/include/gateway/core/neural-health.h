#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <boost/json.hpp>

namespace varan {
    namespace gateway {

        // Состояние техзрения по /api/neural/status бэкенда для регистра 0x1007
        namespace neural_health {

            // Опрос бэкенда и оценка; 1 — исправно, reason — код причины для страницы
            std::uint16_t poll(const std::string& backend_url, const std::string& camera_id, boost::json::object& reason);

            // 1 — все платы в сети и их слоты запущены; camera_id пусто — все плитки камер ok,
            // иначе — плитка этой камеры ok в запущенном слоте
            std::uint16_t evaluate(const boost::json::value& body, const std::string& camera_id, boost::json::object& reason);

            // Причина по частям для страницы
            std::vector<std::string> reason_parts(const boost::json::object& reason);

            std::string str(const boost::json::object& o, const char* key);

        } // namespace neural_health

    } // namespace gateway
} // namespace varan
