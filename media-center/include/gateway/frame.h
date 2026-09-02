#pragma once

#include <string>
#include <vector>
#include <array>
#include <optional>
#include <functional>
#include <cstdint>

namespace varan {
namespace gateway {

    // Семантика кадра для отправки в message-gateway
    struct FGatewayDetection {
        int cid = 0;                        // числовой id класса
        std::string cls;                    // имя класса
        double cf = 0.0;                    // confidence 0..1
        std::array<int, 4> box{ 0, 0, 0, 0 }; // x, y, w, h в пикселях
        std::optional<std::string> scls;    // подкатегория (superclass)
    };

    struct FGatewayFrame {
        int ver = 1;                        // версия протокола
        std::int64_t id = 0;
        std::int64_t ts = 0;                // unix-время, мс
        int width = 0;
        int height = 0;
        std::string format;                 // jpeg / png / webp
        std::string camera_id;              // источник кадра
        // Конфигурация нейросети, которой получены обнаружения. 
        // ID классов осмысленны только внутри своей конфигурации, поэтому шлюз
        // по id конфигурации выбирает таблицу соответствий
        std::string config_id;
        std::string image;                  // закодированные байты изображения
        std::vector<FGatewayDetection> dets;   // Список обнаружений
    };

    // Неблокирующая отправка кадра в шлюз (перемещаемый, т.к. несёт изображение).
    using FGatewayFrameSender = std::function<void(FGatewayFrame)>;

    // Точное время + GPS шлюза
    struct FGatewayTimeGps {
        std::int64_t unix_ms = 0;
        // Время получено шлюзом от Садко. Каким транспортом тот подключён —
        // CAN, Modbus, TCP — неважно, важен источник
        bool sadko_time = false;
        double lat = 0.0;
        double lon = 0.0;
        double alt = 0.0;
        bool valid = false;
        int sats = 0;
        double speed = 0.0;   // м/с
        double course = 0.0;  // градусы
    };

    // Колбэк, которым UGatewayClient сообщает загрузчику свежий снимок времени и gps
    using FGatewayTimeCallback = std::function<void(const FGatewayTimeGps&)>;

    // Этим колбэком отдает текущее синхронизированное время и gps
    using FGatewayTimeProvider = std::function<FGatewayTimeGps()>;

} // namespace gateway
} // namespace varan