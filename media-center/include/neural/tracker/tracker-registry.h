#pragma once

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <type_traits>
#include <vector>

#include <boost/json.hpp>

#include "neural/utility.h"
#include "iou-tracker.h"
#include "kalman-iou-tracker.h"

namespace varan {
namespace neural {

    // Тип трекера: разбор блока tracker конфигурации, умолчания для фронта, создание
    struct FTrackerType {
        std::string type;
        std::string name;
        std::function<std::shared_ptr<FTrackerConfig>(const boost::json::object& tracker, const FConfigInfo& info)> parse;
        std::function<boost::json::object()> defaults;
        std::function<std::shared_ptr<IDetectionTracker>(const FTrackerConfig& config, std::atomic<std::int64_t>* track_ids)> make;
    };

    // Числовые поля конфигурации трекера: один список для разбора и умолчаний
    template <class F> void tracker_fields(FIoUTrackerConfig& c, F&& f) {
        f("iou_threshold", c.iou_threshold);
        f("min_hits", c.min_hits);
        f("max_lost", c.max_lost);
        f("move_threshold", c.move_threshold);
    }

    template <class F> void tracker_fields(FKalmanIoUTrackerConfig& c, F&& f) {
        f("iou_threshold", c.iou_threshold);
        f("min_size_similarity", c.min_size_similarity);
        f("low_confidence", c.low_confidence);
        f("low_iou_threshold", c.low_iou_threshold);
        f("min_hits", c.min_hits);
        f("max_lost_s", c.max_lost_s);
        f("move_threshold", c.move_threshold);
        f("std_position", c.std_position);
        f("std_velocity", c.std_velocity);
    }

    // Отсутствующее поле остаётся по умолчанию
    template <class T> T read_tracker_fields(const boost::json::object& o) {
        T c;
        tracker_fields(c, [&](const char* key, auto& v) {
            if (auto* x = o.if_contains(key); x && x->is_number()) v = x->to_number<std::decay_t<decltype(v)>>();
        });
        return c;
    }

    template <class T> boost::json::object write_tracker_fields(T c) {
        boost::json::object o;
        // Дробные поля округляются до 6 знаков, чтобы 0.3f не уходил как 0.30000001192092896
        tracker_fields(c, [&](const char* key, auto& v) {
            if constexpr (std::is_floating_point_v<std::decay_t<decltype(v)>>) o[key] = std::round(double(v) * 1e6) / 1e6;
            else o[key] = v;
        });
        return o;
    }

    inline const char* match_by_str(EMatchBy m) {
        return m == EMatchBy::CLASS ? "class" : "superclass";
    }

    inline const std::vector<FTrackerType>& tracker_types() {
        static const std::vector<FTrackerType> types = {
            {
                "iou", "IoU-трекер",
                [](const boost::json::object& o, const FConfigInfo&) -> std::shared_ptr<FTrackerConfig> {
                    auto c = std::make_shared<FIoUTrackerConfig>(read_tracker_fields<FIoUTrackerConfig>(o));
                    c->type = "iou";
                    return c;
                },
                [] { return write_tracker_fields(FIoUTrackerConfig{}); },
                [](const FTrackerConfig& c, std::atomic<std::int64_t>* ids) -> std::shared_ptr<IDetectionTracker> {
                    return std::make_shared<UIoUTracker>(static_cast<const FIoUTrackerConfig&>(c), ids);
                },
            },
            {
                "kalman_iou", "Калман + IoU",
                [](const boost::json::object& o, const FConfigInfo& info) -> std::shared_ptr<FTrackerConfig> {
                    auto c = std::make_shared<FKalmanIoUTrackerConfig>(read_tracker_fields<FKalmanIoUTrackerConfig>(o));
                    c->type = "kalman_iou";
                    if (auto* m = o.if_contains("match_by"); m && m->is_string())
                        c->match_by = m->as_string() == match_by_str(EMatchBy::CLASS) ? EMatchBy::CLASS : EMatchBy::SUPERCLASS;
                    c->confidence = info.thresholds.confidence;
                    c->min_confidence = c->low_confidence;
                    // Класс с суперклассом получает группу -2 - номер суперкласса, без суперкласса — свой номер
                    const auto& sc = info.superclasses;
                    for (const auto& cls : info.classes) {
                        if (cls.id < 0) continue;
                        if (static_cast<int>(c->group_of_class.size()) <= cls.id) c->group_of_class.resize(cls.id + 1, -1);
                        const auto it = std::find_if(sc.begin(), sc.end(), [&](const auto& s) { return s.key == cls.superclass; });
                        c->group_of_class[cls.id] = it == sc.end() ? cls.id : -2 - static_cast<int>(it - sc.begin());
                    }
                    return c;
                },
                [] {
                    FKalmanIoUTrackerConfig c;
                    auto o = write_tracker_fields(c);
                    o["match_by"] = match_by_str(c.match_by);
                    return o;
                },
                [](const FTrackerConfig& c, std::atomic<std::int64_t>* ids) -> std::shared_ptr<IDetectionTracker> {
                    return std::make_shared<UKalmanIoUTracker>(static_cast<const FKalmanIoUTrackerConfig&>(c), ids);
                },
            },
        };
        return types;
    }

    // nullptr — тип не реализован
    inline const FTrackerType* find_tracker_type(const std::string& type) {
        for (const auto& t : tracker_types()) if (t.type == type) return &t;
        return nullptr;
    }

} // namespace neural
} // namespace varan
