#pragma once

#include <cstdint>
#include <string>

namespace varan {
namespace archive {

    // Откуда взято настенное время на момент события
    enum class ETimeSource {
        NONE,    // шлюз молчит: тикают системные часы, доверия ноль
        SYSTEM,  // шлюз ответил, использует свое системное время
        NTP,     // часы шлюза выверены по NTP — время верное
        SADKO    // время от Садко — достовернее всего
    };

    inline const char* to_string(ETimeSource source) {
        switch (source) {
        case ETimeSource::SADKO:  return "sadko";
        case ETimeSource::NTP:    return "ntp";
        case ETimeSource::SYSTEM: return "system";
        default:                  return "none";
        }
    }

    // События, которые приходят на запись
    struct FSegmentEvent {
        // Статус сегмента, открыт - media-center начал писать, сегмент не закончен
        // закрыт - сегмент полностью валидный и оконченный, его время можно брать из записи в БД
        // TIME_MARK - не сегмент, а точка соответствия mono и wall при улучшении источника
        // ERROR - причина, по которой запись прервалась на конце сегмента
        enum class EKind { OPENED, CLOSED, ERROR, TIME_MARK };

        EKind kind = EKind::OPENED;

        std::string camera_id;
        std::string stream_key;
        std::string path;         // абсолютный путь файла — ключ строки
        std::string volume_id;    // том пула, на котором открыт фрагмент; пусто — без пула

        // Время со старта записи, не привязаны ни к системному, ни к шине
        std::int64_t mono_ms = 0;
        // Текущее время и его источник
        std::int64_t wall_ms = 0;
        ETimeSource source = ETimeSource::NONE;

        // Только для CLOSED: конец в mono_ms/wall_ms; без него конец домеряет storage-service
        bool has_end = false;
        // Только для CLOSED; -1 — размер неизвестен
        std::int64_t size_bytes = -1;

        // Только для ERROR: "<код>: <подробности>"
        std::string error;
    };

} // namespace archive
} // namespace varan
