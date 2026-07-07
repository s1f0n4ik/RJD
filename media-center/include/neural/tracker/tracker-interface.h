#pragma once

#include <vector>
#include <cstdint>

#include "tracking-types.h"

namespace varan {
namespace neural {

    class IDetectionTracker {
    public:
        virtual ~IDetectionTracker() = default;

        // Обновить треки новыми детекциями.
        // Возвращает события, отфильтрованные по event_mask
        virtual FTrackerUpdateResult update(
            const std::vector<FDetection>& detections,
            int frame_width = 1,
            int frame_height = 1) = 0;

        // Все текущие треки
        virtual const std::vector<FTrack>& tracks() const = 0;

        // Сброс всех треков.
        virtual void reset() = 0;

        // Текущая маска событий.
        uint32_t event_mask() const { return m_event_mask; }
        void set_event_mask(uint32_t mask) { m_event_mask = mask; }

    protected:
        // Фильтр события по маске
        // Вызывается конкретной реализацией перед возвратом
        FTrackerUpdateResult filter_events(std::vector<FTrackEventRecord>&& all_events) const {
            FTrackerUpdateResult result;
            result.events.reserve(all_events.size());
            for (auto& e : all_events) {
                if (event_matches_mask(e.event, m_event_mask)) {
                    result.events.push_back(std::move(e));
                }
            }
            return result;
        }

        uint32_t m_event_mask = EVENT_ALL;
    };

} // namespace neural
} // namespace varan