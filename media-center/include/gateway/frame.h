#pragma once

#include <string>
#include <vector>
#include <array>
#include <optional>
#include <functional>
#include <cstdint>

namespace varan {
namespace gateway {

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
        // Конфигурация нейросети, которой получены обнаружения. Имена классов
        // (cls/scls) осмысленны только внутри своей конфигурации, поэтому шлюз
        // по этому id выбирает таблицу соответствий.
        std::string config_id;
        std::string image;                  // закодированные байты изображения
        std::vector<FGatewayDetection> dets;
    };

    // Неблокирующая отправка кадра в шлюз (перемещаемый, т.к. несёт изображение).
    using FGatewayFrameSender = std::function<void(FGatewayFrame)>;

    // Точное время + GPS шлюза (см. UGatewayClient::GetTime). UNeuralLoader
    // опрашивает раз в 10с и держит локальный тикающий таймер поверх последнего
    // снимка — тот же приём, что и в krsps-панели времени на фронте.
    struct FGatewayTimeGps {
        std::int64_t unix_ms = 0;
        double lat = 0.0;
        double lon = 0.0;
        double alt = 0.0;
        bool valid = false;
        int sats = 0;
        double speed = 0.0;   // м/с
        double course = 0.0;  // градусы
    };

    // Колбэк, которым UGatewayClient сообщает загрузчику свежий снимок времени/GPS.
    using FGatewayTimeCallback = std::function<void(const FGatewayTimeGps&)>;

    // Колбэк, которым загрузчик отдаёт слоту текущее (синхронизированное локальным
    // таймером) время + GPS одной структурой — именно её слот использует для
    // простановки времени в сообщении шлюзу.
    using FGatewayTimeProvider = std::function<FGatewayTimeGps()>;

} // namespace gateway
} // namespace varan