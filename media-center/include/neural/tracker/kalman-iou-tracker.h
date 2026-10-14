#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <map>
#include <vector>

#include <opencv2/core.hpp>

#include "tracker-interface.h"

namespace varan {
namespace neural {

    enum class EMatchBy { CLASS, SUPERCLASS };

    // Параметры трекера Калман + IoU
    struct FKalmanIoUTrackerConfig : public FTrackerConfig {
        EMatchBy match_by = EMatchBy::SUPERCLASS;
        float iou_threshold = 0.3f;       // минимальный IoU с предсказанной рамкой для уверенных детекций
        float low_confidence = 0.1f;      // нижний порог слабых детекций второго прохода
        float low_iou_threshold = 0.5f;   // минимальный IoU для слабых детекций
        int   min_hits = 3;               // совпадений до подтверждения
        float max_lost_s = 1.0f;          // секунд в потере до удаления
        float move_threshold = 0.05f;     // накопленный сдвиг центра в долях диагонали кадра для UPDATED
        float std_position = 0.05f;       // шум положения в долях размера рамки
        float std_velocity = 0.00625f;    // шум скорости в долях размера рамки
        float confidence = 0.5f;          // основной порог уверенности конфигурации
        std::vector<int> group_of_class;  // группа сопоставления по номеру класса; -1 — сам класс
    };

    // Фильтр рамки: состояние [cx, cy, w, h, vcx, vcy, vw, vh], постоянная скорость, шумы от размера рамки
    class UKalmanBoxFilter {
    public:
        // Шумы заданы на шаг 1/30 с, как в ByteTrack
        static constexpr float STEPS_PER_SECOND = 30.f;

        UKalmanBoxFilter(const FDetection& box, float std_position, float std_velocity)
            : m_sp(std_position)
            , m_sv(std_velocity)
        {
            const auto z = measure(box);
            for (int i = 0; i < 4; ++i) m_x(i) = z(i);
            const float w = z(2), h = z(3);
            const float s[8] = { 2 * m_sp * w, 2 * m_sp * h, 2 * m_sp * w, 2 * m_sp * h,
                10 * m_sv * w, 10 * m_sv * h, 10 * m_sv * w, 10 * m_sv * h };
            for (int i = 0; i < 8; ++i) m_p(i, i) = s[i] * s[i];
        }

        // dt в секундах; freeze_size обнуляет скорость ширины и высоты
        void predict(float dt, bool freeze_size) {
            if (freeze_size) m_x(6) = m_x(7) = 0.f;
            const float steps = dt * STEPS_PER_SECOND;
            auto f = cv::Matx<float, 8, 8>::eye();
            for (int i = 0; i < 4; ++i) f(i, i + 4) = steps;
            const float w = m_x(2), h = m_x(3);
            const float s[8] = { m_sp * w, m_sp * h, m_sp * w, m_sp * h, m_sv * w, m_sv * h, m_sv * w, m_sv * h };
            auto q = cv::Matx<float, 8, 8>::zeros();
            for (int i = 0; i < 8; ++i) q(i, i) = s[i] * s[i] * steps;
            m_x = f * m_x;
            m_p = f * m_p * f.t() + q;
        }

        void update(const FDetection& box) {
            auto hm = cv::Matx<float, 4, 8>::zeros();
            for (int i = 0; i < 4; ++i) hm(i, i) = 1.f;
            const float w = m_x(2), h = m_x(3);
            const float s[4] = { m_sp * w, m_sp * h, m_sp * w, m_sp * h };
            auto r = cv::Matx<float, 4, 4>::zeros();
            for (int i = 0; i < 4; ++i) r(i, i) = s[i] * s[i];
            const cv::Matx<float, 8, 4> k = m_p * hm.t() * (hm * m_p * hm.t() + r).inv(cv::DECOMP_CHOLESKY);
            m_x += k * (measure(box) - hm * m_x);
            m_p = (cv::Matx<float, 8, 8>::eye() - k * hm) * m_p;
        }

        // Текущая оценка рамки
        FDetection box() const {
            const float w = std::max(1.f, m_x(2));
            const float h = std::max(1.f, m_x(3));
            FDetection d{};
            d.x1_coord = static_cast<int>(std::lround(m_x(0) - w / 2));
            d.y1_coord = static_cast<int>(std::lround(m_x(1) - h / 2));
            d.x2_coord = static_cast<int>(std::lround(m_x(0) + w / 2));
            d.y2_coord = static_cast<int>(std::lround(m_x(1) + h / 2));
            return d;
        }

    private:
        static cv::Matx<float, 4, 1> measure(const FDetection& d) {
            return cv::Matx<float, 4, 1>((d.x1_coord + d.x2_coord) * 0.5f, (d.y1_coord + d.y2_coord) * 0.5f,
                float(d.x2_coord - d.x1_coord), float(d.y2_coord - d.y1_coord));
        }

        float m_sp;
        float m_sv;
        cv::Matx<float, 8, 1> m_x = cv::Matx<float, 8, 1>::zeros();
        cv::Matx<float, 8, 8> m_p = cv::Matx<float, 8, 8>::zeros();
    };

    // Трекер Калман + IoU: сопоставление с предсказанной рамкой в два прохода — уверенные, затем слабые детекции
    class UKalmanIoUTracker : public IDetectionTracker {
    public:
        UKalmanIoUTracker(const FKalmanIoUTrackerConfig& config, std::atomic<std::int64_t>* track_ids)
            : m_config(config)
            , m_track_ids(track_ids)
        {
            m_event_mask = config.event_mask;
        }

        FTrackerUpdateResult update(const std::vector<FDetection>& detections, int frame_width, int frame_height) override {
            return update(detections, FTrackerFrame{ .width = frame_width, .height = frame_height, .at = clock::now() });
        }

        FTrackerUpdateResult update(const std::vector<FDetection>& detections, const FTrackerFrame& frame) override {
            std::vector<FTrackEventRecord> events;

            const float dt = m_last == clock::time_point{} ? 0.f : std::max(0.f, seconds(frame.at - m_last));
            m_last = frame.at;
            for (auto& t : m_state) {
                t.filter.predict(dt, t.out.state == ETrackState::LOST);
                t.out.age++;
            }

            std::vector<int> high;
            std::vector<int> low;
            for (int d = 0; d < static_cast<int>(detections.size()); ++d) {
                if (detections[d].confidence >= m_config.confidence) high.push_back(d);
                else if (detections[d].confidence >= m_config.low_confidence) low.push_back(d);
            }

            std::vector<bool> matched(m_state.size(), false);
            const auto fresh = match(detections, high, matched, m_config.iou_threshold, true, frame, events);
            match(detections, low, matched, m_config.low_iou_threshold, false, frame, events);

            // Несопоставленный трек идёт по предсказанию, подтверждённый сразу становится потерянным
            for (size_t i = 0; i < m_state.size(); ++i) {
                if (matched[i]) continue;
                auto& o = m_state[i].out;
                o.lost_frames++;
                FDetection predicted = m_state[i].filter.box();
                predicted.class_id = o.class_id;
                predicted.confidence = o.confidence;
                o.detection = std::move(predicted);
                if (o.state == ETrackState::CONFIRMED) {
                    o.state = ETrackState::LOST;
                    events.push_back({ ETrackEvent::LOST, o });
                }
            }

            // Пробный трек живёт до первого пропуска, потерянный — до срока или выхода центра из видимых окон
            std::erase_if(m_state, [&](const FKalmanTrack& t) {
                const auto& o = t.out;
                if (o.lost_frames == 0) return false;
                if (o.state == ETrackState::TENTATIVE) return true;
                const bool gone = seconds(frame.at - t.seen) > m_config.max_lost_s || !visible(frame, o.detection);
                if (gone) events.push_back({ ETrackEvent::REMOVED, o });
                return gone;
            });

            for (int d : fresh) {
                const auto& det = detections[d];
                FKalmanTrack t{ FTrack{}, UKalmanBoxFilter(det, m_config.std_position, m_config.std_velocity), {}, frame.at, det };
                auto& o = t.out;
                o.detection = det;
                o.class_id = det.class_id;
                o.confidence = det.confidence;
                o.age = 1;
                o.hits = 1;
                t.votes[det.class_id] = det.confidence;
                if (m_config.min_hits <= 1) {
                    o.state = ETrackState::CONFIRMED;
                    o.id = m_track_ids->fetch_add(1);
                    events.push_back({ ETrackEvent::CONFIRMED, o });
                }
                else {
                    o.state = ETrackState::TENTATIVE;
                    events.push_back({ ETrackEvent::CREATED, o });
                }
                m_state.push_back(std::move(t));
            }

            m_tracks.clear();
            for (const auto& t : m_state) m_tracks.push_back(t.out);
            return filter_events(std::move(events));
        }

        const std::vector<FTrack>& tracks() const override {
            return m_tracks;
        }

        void reset() override {
            m_state.clear();
            m_tracks.clear();
            m_last = {};
        }

    private:
        using clock = std::chrono::steady_clock;

        struct FKalmanTrack {
            FTrack out;
            UKalmanBoxFilter filter;
            // Класс → накопленная уверенность
            std::map<int, float> votes;
            clock::time_point seen;
            // Рамка последнего подтверждения или «Движения»
            FDetection anchor;
        };

        static float seconds(clock::duration d) {
            return std::chrono::duration<float>(d).count();
        }

        static float box_iou(const FDetection& a, const FDetection& b) {
            const float ix1 = float(std::max(a.x1_coord, b.x1_coord));
            const float iy1 = float(std::max(a.y1_coord, b.y1_coord));
            const float ix2 = float(std::min(a.x2_coord, b.x2_coord));
            const float iy2 = float(std::min(a.y2_coord, b.y2_coord));
            if (ix1 >= ix2 || iy1 >= iy2) return 0.f;
            const float inter = (ix2 - ix1) * (iy2 - iy1);
            const float u = float(a.x2_coord - a.x1_coord) * float(a.y2_coord - a.y1_coord)
                + float(b.x2_coord - b.x1_coord) * float(b.y2_coord - b.y1_coord) - inter;
            return u > 0 ? inter / u : 0.f;
        }

        static cv::Point2f center(const FDetection& d) {
            return { (d.x1_coord + d.x2_coord) * 0.5f, (d.y1_coord + d.y2_coord) * 0.5f };
        }

        // Центр рамки внутри одного из видимых окон; без окон — внутри кадра
        static bool visible(const FTrackerFrame& frame, const FDetection& d) {
            const cv::Point2f c = center(d);
            if (frame.visible.empty()) return cv::Rect2f(0.f, 0.f, float(frame.width), float(frame.height)).contains(c);
            return std::any_of(frame.visible.begin(), frame.visible.end(), [&](const cv::Rect2f& r) { return r.contains(c); });
        }

        int group(int class_id) const {
            const auto& g = m_config.group_of_class;
            const bool by_superclass = m_config.match_by == EMatchBy::SUPERCLASS;
            if (by_superclass && class_id >= 0 && class_id < static_cast<int>(g.size()) && g[class_id] != -1) return g[class_id];
            return class_id;
        }

        // Жадное сопоставление по убыванию IoU с предсказанной рамкой; возвращает несопоставленные детекции
        std::vector<int> match(const std::vector<FDetection>& dets, const std::vector<int>& pool, std::vector<bool>& matched,
            float threshold, bool with_tentative, const FTrackerFrame& frame, std::vector<FTrackEventRecord>& events)
        {
            struct FCandidate { float iou; size_t t; int d; };
            std::vector<FCandidate> candidates;
            for (size_t t = 0; t < m_state.size(); ++t) {
                if (matched[t] || (!with_tentative && m_state[t].out.state == ETrackState::TENTATIVE)) continue;
                const FDetection predicted = m_state[t].filter.box();
                const int track_group = group(m_state[t].out.class_id);
                for (int d : pool) {
                    if (group(dets[d].class_id) != track_group) continue;
                    const float iou = box_iou(predicted, dets[d]);
                    if (iou >= threshold) candidates.push_back({ iou, t, d });
                }
            }
            std::sort(candidates.begin(), candidates.end(), [](const FCandidate& a, const FCandidate& b) { return a.iou > b.iou; });

            std::vector<bool> used(dets.size(), false);
            for (const auto& c : candidates) {
                if (matched[c.t] || used[c.d]) continue;
                matched[c.t] = true;
                used[c.d] = true;
                hit(m_state[c.t], dets[c.d], frame, events);
            }

            std::vector<int> rest;
            for (int d : pool) if (!used[d]) rest.push_back(d);
            return rest;
        }

        void hit(FKalmanTrack& t, const FDetection& det, const FTrackerFrame& frame, std::vector<FTrackEventRecord>& events) {
            t.filter.update(det);
            t.seen = frame.at;
            t.votes[det.class_id] += det.confidence;

            auto& o = t.out;
            o.class_id = std::max_element(t.votes.begin(), t.votes.end(),
                [](const auto& a, const auto& b) { return a.second < b.second; })->first;
            o.detection = det;
            o.detection.class_id = o.class_id;
            o.confidence = det.confidence;
            o.hits++;
            o.lost_frames = 0;

            if (o.state == ETrackState::TENTATIVE && o.hits >= m_config.min_hits) {
                o.state = ETrackState::CONFIRMED;
                o.id = m_track_ids->fetch_add(1);
                t.anchor = det;
                events.push_back({ ETrackEvent::CONFIRMED, o });
            }
            else if (o.state == ETrackState::LOST) {
                o.state = ETrackState::CONFIRMED;
                events.push_back({ ETrackEvent::RECOVERED, o });
            }
            else if (o.state == ETrackState::CONFIRMED) {
                const cv::Point2f shift = center(det) - center(t.anchor);
                const float diag = std::hypot(float(frame.width), float(frame.height));
                if (diag > 0 && std::hypot(shift.x, shift.y) / diag > m_config.move_threshold) {
                    t.anchor = det;
                    events.push_back({ ETrackEvent::UPDATED, o });
                }
            }
        }

    private:
        FKalmanIoUTrackerConfig m_config;
        std::vector<FKalmanTrack> m_state;
        // Зеркало внешней части треков для tracks()
        std::vector<FTrack> m_tracks;
        clock::time_point m_last;
        // Счётчик номеров треков загрузчика, общий для всех слотов
        std::atomic<std::int64_t>* m_track_ids;
    };

} // namespace neural
} // namespace varan
