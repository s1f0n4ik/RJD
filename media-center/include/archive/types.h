#pragma once

#include <cstdint>
#include <string>

namespace varan {
namespace archive {

    // Откуда взято настенное время на момент события
    enum class ETimeSource {
        NONE,    // шлюз молчит: тикают системные часы, доверия ноль
        SYSTEM,  // шлюз ответил, использует свое системное время
        SADKO    // время от Садко — единственное достоверное
    };

    inline const char* to_string(ETimeSource source) {
        switch (source) {
        case ETimeSource::SADKO:  return "sadko";
        case ETimeSource::SYSTEM: return "system";
        default:                  return "none";
        }
    }

    // События, которые приходят на запись
    struct FSegmentEvent {
        // Статус сегмента, открыт - media-center начал писать, сегмент не закончен
        // закрыт - сегмент полностью валидный и оконченный, его время можно брать из записи в БД
        enum class EKind { OPENED, CLOSED };

        EKind kind = EKind::OPENED;

        std::string camera_id;
        std::string stream_key;
        std::string path;         // абсолютный путь файла — ключ строки

        // Время со старта записи, не привязаны ни к системному, ни к шине
        std::int64_t mono_ms = 0;
        // Текущее время и его источник
        std::int64_t wall_ms = 0;
        ETimeSource source = ETimeSource::NONE;

        // Только для CLOSED
        std::int64_t size_bytes = 0;
    };

} // namespace archive
} // namespace varan
