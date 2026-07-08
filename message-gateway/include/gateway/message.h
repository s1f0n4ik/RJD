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
        };

    } // namespace gateway
} // namespace varan
