#pragma once

#include <string>
#include <cstdint>

#include "gateway/can-bus.h"

namespace varan {
    namespace gateway {

        // Разобранный 29-битный идентификатор J1939.
        struct FJ1939Id {
            int priority = 0;
            int pgn = 0;
            int src = 0;   // SA — адрес источника
            int dst = 0;   // PS для адресных сообщений (PDU1), иначе часть PGN
        };

        // Собирает 29-битный id: приоритет | DP | PF | PS | SA. Для PDU1 (PF < 0xF0)
        // в PS уходит адрес получателя, для PDU2 (PF >= 0xF0) PS — часть PGN, и dst
        // игнорируется. Наше сообщение обнаружений — PGN 0xEF00 (PDU1), приоритет 0,
        // SA 0x71: даёт 0x00EF0071.
        std::uint32_t make_j1939_id(int priority, int pgn, int src, int dst);

        // Обратный разбор. Всегда успешен для 29-битного id.
        FJ1939Id parse_j1939_id(std::uint32_t id);

        // Полезная нагрузка исходящего сообщения технического зрения. Числа уже
        // разрешены через общую таблицу соответствий (UTaxonomy).
        struct FCanDetectionPayload {
            int count = 0;    // байт 1 — количество обнаружений
            int type = 0;     // байт 2 — тип обнаружения с наивысшей опасностью
            int danger = 0;   // байт 3 — класс опасности
            int camera = 0;   // байт 4 — id камеры
        };

        // Раскладывает нагрузку по байтам кадра. Байты сверх четырёх заполняются
        // 0xFF — в J1939 это "значение недоступно", а не ноль.
        FCanFrame encode_detection_frame(const FCanDetectionPayload& p, int priority,
            int pgn, int src, int dst, int dlc);

        // Координаты из сообщения Садко (PGN 0xFF00): градусы/минуты/секунды с
        // отдельными битами знака, секунды — uint16 LE в тысячных.
        struct FCanGps {
            double lat = 0.0;
            double lon = 0.0;
        };

        // false, если кадр короче 8 байт или знаки широты/долготы заданы
        // противоречиво (оба бита или ни одного).
        bool decode_gps_frame(const FCanFrame& f, FCanGps& out, std::string& err);

        // Дата, время UTC и путевая скорость из сообщения Садко (PGN 0xFF01).
        struct FCanTime {
            std::int64_t unix_ms = 0;
            double speed = 0.0;   // м/с, в кадре 0.01 м/с на бит
        };

        bool decode_time_frame(const FCanFrame& f, FCanTime& out, std::string& err);

    } // namespace gateway
} // namespace varan
