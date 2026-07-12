#pragma once

#include <string>
#include <vector>
#include <array>
#include <optional>
#include <functional>
#include <cstdint>

namespace varan {
namespace neural {

    // Семантика кадра для отправки в message-gateway. Без protobuf/gRPC-типов,
    // чтобы слот и загрузчик не тянули зависимости gRPC — трансляцию в proto
    // делает UGatewayClient в своей единице трансляции.
    struct FGatewayDetection {
        int cid = 0;                        // числовой id класса
        std::string cls;                    // имя класса
        double cf = 0.0;                    // confidence 0..1
        std::array<int, 4> box{ 0, 0, 0, 0 }; // x, y, w, h в пикселях
        std::optional<std::string> scls;    // подкатегория (superclass)
    };

    struct FGatewayFrame {
        int ver = 1;                        // версия протокола (кодек шлюза)
        std::int64_t id = 0;
        std::int64_t ts = 0;                // unix-время, мс
        int width = 0;
        int height = 0;
        std::string format;                 // jpeg / png / webp
        std::string camera_id;              // источник кадра
        std::string image;                  // закодированные байты изображения
        std::vector<FGatewayDetection> dets;
    };

    // Неблокирующая отправка кадра в шлюз (перемещаемый, т.к. несёт изображение).
    using FGatewayFrameSender = std::function<void(FGatewayFrame)>;

} // namespace neural
} // namespace varan