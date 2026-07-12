#pragma once

#include <string>
#include <vector>
#include <array>
#include <optional>
#include <cstdint>

namespace varan {
    namespace gateway {

        // Одно обнаружение нейросети. Семантика, а не байты конкретного протокола.
        struct FDetection {
            int cid = 0;                      // числовой id класса
            std::string cls;                  // имя класса
            double cf = 0.0;                  // confidence 0..1
            std::array<int, 4> box{ 0, 0, 0, 0 }; // x, y, w, h
            std::optional<std::string> scls;  // подкатегория (info/warning/danger)
        };

        // Семантическое сообщение кадра от media-center. Кодек превращает его в
        // wire-формат конкретной версии протокола. Ядро НЕ знает про раскладку байт.
        struct FFrameMessage {
            int ver = 0;                      // версия протокола, запрошенная клиентом
            std::int64_t id = 0;
            std::int64_t ts = 0;
            int width = 0;
            int height = 0;
            std::string format;               // jpeg / png / webp
            std::vector<FDetection> dets;
            std::string image;                // сырые байты изображения
            std::string camera_id;            // идентификатор камеры-источника
        };

        // Точный снимок времени + GPS шлюза. Единый источник для REST (/time,
        // /gps) и gRPC (GetTime) — оба транспорта форматируют один и тот же снимок.
        struct FTimeGpsSnapshot {
            std::int64_t unix_ms = 0;
            double lat = 0.0;
            double lon = 0.0;
            double alt = 0.0;
            bool valid = false;
            int sats = 0;
            double speed = 0.0;    // м/с
            double course = 0.0;  // градусы
        };

    } // namespace gateway
} // namespace varan
