#pragma once

#include <string>
#include <vector>
#include <array>
#include <optional>
#include <cstdint>

namespace varan {
    namespace gateway {

        // Событие трека, на котором мастер записал обнаружение; номера как в proto
        enum class ETrackEvent {
            Unspecified = 0,
            Created = 1,
            Confirmed = 2,
            Updated = 3,
            Lost = 4,
            Recovered = 5,
            Removed = 6
        };

        // Одно обнаружение нейросети. Семантика, а не байты конкретного протокола.
        struct FDetection {
            int cid = 0;                      // числовой id класса
            std::string cls;                  // имя класса
            double cf = 0.0;                  // confidence 0..1
            std::array<int, 4> box{ 0, 0, 0, 0 }; // x, y, w, h
            std::optional<std::string> scls;  // подкатегория (info/warning/danger)
            std::uint64_t detection_id = 0;   // ID обнаружения у мастера
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
            // Конфигурация нейросети, которой получены обнаружения. Имена классов
            // осмысленны только внутри своей конфигурации, поэтому таблица
            // соответствий выбирается по этому id. Пусто — таблица не ищется.
            std::string config_id;
            std::int64_t session = 0;         // время запуска мастера, unix мс
            ETrackEvent event = ETrackEvent::Unspecified;
        };

        // Точный снимок времени + GPS шлюза. Единый источник для REST (/time,
        // /gps) и gRPC (GetTime) — оба транспорта форматируют один и тот же снимок.
        struct FTimeGpsSnapshot {
            // Уже сдвинуто на настроенный пояс: потребители используют как есть
            std::int64_t unix_ms = 0;
            int tz_offset_min = 0;
            // Время взято с шины. false — тикают часы шлюза, доверять нельзя
            bool can_time = false;
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
