#pragma once

#include <vector>
#include <string>
#include <cstdint>

#include "neural/detection.h"

namespace varan {
namespace neural {

    // Состояние трека
    enum class ETrackState {
        TENTATIVE,     // Только появился, не подтверждён
        CONFIRMED,     // Стабильно отслеживается
        LOST,          // Пропал, но ещё может ожить
    };

    // Cобытия состояний
    enum class ETrackEvent {
        CREATED,       // Новый трек (TENTATIVE)
        CONFIRMED,     // Трек подтверждён (TENTATIVE -> CONFIRMED)
        UPDATED,       // Позиция существенно изменилась
        LOST,          // Трек потерян (CONFIRMED -> LOST)
        RECOVERED,     // Трек восстановлен (LOST -> CONFIRMED)
        REMOVED,       // Трек удалён окончательно
    };

    // Битовая маска для фильтрации событий
    enum ETrackEventMask : uint32_t {
        EVENT_NONE = 0,
        EVENT_CREATED = 1 << 0,
        EVENT_CONFIRMED = 1 << 1,
        EVENT_UPDATED = 1 << 2,
        EVENT_LOST = 1 << 3,
        EVENT_RECOVERED = 1 << 4,
        EVENT_REMOVED = 1 << 5,
        EVENT_ALL = 0xFFFFFFFF,

        // Пресеты
        EVENT_STATE_CHANGES = EVENT_CONFIRMED | EVENT_LOST | EVENT_RECOVERED | EVENT_REMOVED,
    };

    inline uint32_t operator|(ETrackEventMask a, ETrackEventMask b) {
        return static_cast<uint32_t>(a) | static_cast<uint32_t>(b);
    }

    inline bool event_matches_mask(ETrackEvent event, uint32_t mask) {
        uint32_t bit = 0;
        switch (event) {
            case ETrackEvent::CREATED: bit = EVENT_CREATED; break;
            case ETrackEvent::CONFIRMED: bit = EVENT_CONFIRMED; break;
            case ETrackEvent::UPDATED: bit = EVENT_UPDATED; break;
            case ETrackEvent::LOST: bit = EVENT_LOST; break;
            case ETrackEvent::RECOVERED: bit = EVENT_RECOVERED;break;
            case ETrackEvent::REMOVED: bit = EVENT_REMOVED; break;
        }
        return (mask & bit) != 0;
    }

    inline const char* track_state_str(ETrackState s) {
        switch (s) {
            case ETrackState::TENTATIVE: return "tentative";
            case ETrackState::CONFIRMED: return "confirmed";
            case ETrackState::LOST: return "lost";
        }
        return "unknown";
    }

    inline const char* track_event_str(ETrackEvent e) {
        switch (e) {
            case ETrackEvent::CREATED: return "created";
            case ETrackEvent::CONFIRMED: return "confirmed";
            case ETrackEvent::UPDATED: return "updated";
            case ETrackEvent::LOST: return "lost";
            case ETrackEvent::RECOVERED: return "recovered";
            case ETrackEvent::REMOVED: return "removed";
        }
        return "unknown";
    }

    // Все события в порядке объявления — единый источник вариантов для выдачи
    // на фронт (идентификаторы; человекочитаемые названия живут во фронте).
    inline std::vector<ETrackEvent> all_track_events() {
        return {
            ETrackEvent::CREATED, ETrackEvent::CONFIRMED, ETrackEvent::UPDATED,
            ETrackEvent::LOST, ETrackEvent::RECOVERED, ETrackEvent::REMOVED,
        };
    }

    // Бит маски по идентификатору события (обратно к track_event_str).
    inline uint32_t event_bit_from_type(const std::string& type) {
        if (type == "created")   return EVENT_CREATED;
        if (type == "confirmed") return EVENT_CONFIRMED;
        if (type == "updated")   return EVENT_UPDATED;
        if (type == "lost")      return EVENT_LOST;
        if (type == "recovered") return EVENT_RECOVERED;
        if (type == "removed")   return EVENT_REMOVED;
        return EVENT_NONE;
    }

    // Перевод списка идентификаторов (с фронта) в битовую маску для кода.
    // Пустой список — маска не задана, трекер оставляет свой дефолт (EVENT_ALL).
    inline uint32_t event_mask_from_types(const std::vector<std::string>& types) {
        uint32_t mask = EVENT_NONE;
        for (const auto& t : types) mask |= event_bit_from_type(t);
        return mask;
    }

    // Структура трекируемого объекта
    struct FTrack {
        int id = -1;
        FDetection detection; // последняя известная позиция
        int class_id = -1;
        float confidence = 0.0f; 
        int age = 0; // всего кадров существования
        int hits = 0; // сколько раз найден
        int lost_frames = 0; // подряд кадров без нахождения
        ETrackState state = ETrackState::TENTATIVE;
    };

    // Запись события трека
    struct FTrackEventRecord {
        ETrackEvent event;
        FTrack track; // Сюда нужна копия трека
    };

    // Конфигурация трекера
    struct FTrackerConfig {
        // Какие события считать значимыми.
        // Управляет фильтрацией в результате update()
        uint32_t event_mask = EVENT_ALL;
    };

    // Результат обновления трекера
    struct FTrackerUpdateResult {
        // События, прошедшие через event_mask.
        std::vector<FTrackEventRecord> events;

        bool has_events() const { return !events.empty(); }
    };

    // Параметры IoU-трекера
    struct FIoUTrackerConfig : public FTrackerConfig {
        float iou_threshold = 0.3f;  // минимальный IoU
        int   min_hits = 4; // кадров до подтверждения
        int   max_lost = 8; // кадров до удаления
        float move_threshold = 0.05f; // нормализованный сдвиг центра для UPDATED
    };

} // namespace neural
} // namespace varan