#pragma once

#include <string>
#include <array>
#include <optional>
#include <functional>
#include <cstdint>

namespace varan {
namespace gateway {

    // Обнаружение трека в пакете мастеру
    struct FGatewayDetection {
        int cid = 0;                        // числовой id класса
        std::string cls;                    // имя класса
        double cf = 0.0;                    // confidence 0..1
        std::array<int, 4> box{ 0, 0, 0, 0 }; // x, y, w, h в пикселях
        std::optional<std::string> scls;    // подкатегория (superclass)
    };

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