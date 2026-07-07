#pragma once

#include <vector>
#include <algorithm>
#include <cmath>

#include "tracker-interface.h"

namespace varan {
namespace neural {
    /*
        UIoUTracker — трекер на базе IoU (Intersection over Union).

        Алгоритм:
        1) Матрица IoU между треками и детекциями (только внутри класса)
        2) Жадное сопоставление по убыванию IoU
        3) Несматченные детекции → новые треки
        4) Несматченные треки → lost_frames++
        5) Удаление треков с lost_frames > max_lost
    */
    class UIoUTracker : public IDetectionTracker {
    public:
        explicit UIoUTracker(const FIoUTrackerConfig& config = {})
            : m_config(config)
        {
            m_event_mask = config.event_mask;
        }

        FTrackerUpdateResult update(
            const std::vector<FDetection>& detections,
            int frame_width,
            int frame_height) override
        {
            std::vector<FTrackEventRecord> events;

            const int n_tracks = static_cast<int>(m_tracks.size());
            const int n_dets = static_cast<int>(detections.size());

            // Создание матрицы пересечний
            std::vector<std::vector<float>> iou_matrix(n_tracks, std::vector<float>(n_dets, 0.0f));

            for (int t = 0; t < n_tracks; ++t) {
                for (int d = 0; d < n_dets; ++d) {
                    if (m_tracks[t].class_id == detections[d].class_id) {
                        iou_matrix[t][d] = compute_iou(m_tracks[t].detection, detections[d]);
                    }
                }
            }

            // Жадное сопоставление
            struct Match { float iou; int t; int d; };
            std::vector<Match> candidates;
            candidates.reserve(n_tracks * n_dets);

            for (int t = 0; t < n_tracks; ++t) {
                for (int d = 0; d < n_dets; ++d) {
                    if (iou_matrix[t][d] >= m_config.iou_threshold) {
                        candidates.push_back({ iou_matrix[t][d], t, d });
                    }
                }
            }

            std::sort(candidates.begin(), candidates.end(),
                [](const Match& a, const Match& b) { return a.iou > b.iou; });

            std::vector<bool> track_matched(n_tracks, false);
            std::vector<bool> det_matched(n_dets, false);

            for (const auto& m : candidates) {
                if (track_matched[m.t] || det_matched[m.d]) continue;
                track_matched[m.t] = true;
                det_matched[m.d] = true;

                auto& track = m_tracks[m.t];
                const auto& det = detections[m.d];

                // Проверяем существенное перемещение
                if (track.state == ETrackState::CONFIRMED) {
                    float dx = center_x(det) - center_x(track.detection);
                    float dy = center_y(det) - center_y(track.detection);
                    float dist = std::sqrt(dx * dx + dy * dy);
                    float diag = std::sqrt(
                        float(frame_width) * frame_width +
                        float(frame_height) * frame_height);
                    if (diag > 0 && (dist / diag) > m_config.move_threshold) {
                        // Сначала обновляем detection, потом генерируем событие
                        track.detection = det;
                        track.confidence = det.confidence;
                        events.push_back({ ETrackEvent::UPDATED, track });
                    }
                    else {
                        track.detection = det;
                        track.confidence = det.confidence;
                    }
                }
                else {
                    track.detection = det;
                    track.confidence = det.confidence;
                }

                track.hits++;
                track.age++;
                track.lost_frames = 0;

                // TENTATIVE -> CONFIRMED
                if (track.state == ETrackState::TENTATIVE &&
                    track.hits >= m_config.min_hits)
                {
                    track.state = ETrackState::CONFIRMED;
                    events.push_back({ ETrackEvent::CONFIRMED, track });
                }

                // LOST -> CONFIRMED (восстановление)
                if (track.state == ETrackState::LOST) {
                    track.state = ETrackState::CONFIRMED;
                    events.push_back({ ETrackEvent::RECOVERED, track });
                }
            }

            // Треки, которые не получилось сопоставить считаются потерянными LOST
            for (int t = 0; t < n_tracks; ++t) {
                if (track_matched[t]) continue;
                auto& track = m_tracks[t];
                track.lost_frames++;
                track.age++;
                
                // Генерация события LOST
                if (track.state == ETrackState::CONFIRMED && track.lost_frames == 1) {
                    track.state = ETrackState::LOST;
                    events.push_back({ ETrackEvent::LOST, track });
                }
            }

            // LOST треки у которых > lost_frames удаляем, вызываем событие REMOVED
            {
                auto it = m_tracks.begin();
                while (it != m_tracks.end()) {
                    bool remove = false;

                    if (it->state == ETrackState::TENTATIVE && it->lost_frames > 1) {
                        remove = true;
                    }

                    if (it->lost_frames > m_config.max_lost) {
                        if (it->state == ETrackState::LOST || it->state == ETrackState::CONFIRMED) {
                            events.push_back({ ETrackEvent::REMOVED, *it });
                        }
                        remove = true;
                    }

                    if (remove) {
                        it = m_tracks.erase(it);
                    }
                    else {
                        ++it;
                    }
                }
            }

            // Детекции, которые не относятся ни к одному треку считаем новыми TENTATIVE
            for (int d = 0; d < n_dets; ++d) {
                if (det_matched[d]) continue;

                FTrack track;
                track.id = m_next_id++;
                track.detection = detections[d];
                track.class_id = detections[d].class_id;
                track.confidence = detections[d].confidence;
                track.age = 1;
                track.hits = 1;
                track.lost_frames = 0;

                if (m_config.min_hits <= 1) {
                    track.state = ETrackState::CONFIRMED;
                    events.push_back({ ETrackEvent::CONFIRMED, track });
                }
                else {
                    track.state = ETrackState::TENTATIVE;
                    events.push_back({ ETrackEvent::CREATED, track });
                }

                m_tracks.push_back(std::move(track));
            }

            // Фильтруем события по маске
            return filter_events(std::move(events));
            //return events;
        }

        const std::vector<FTrack>& tracks() const override {
            return m_tracks;
        }

        void reset() override {
            m_tracks.clear();
            m_next_id = 0;
        }

    private:
        static float compute_iou(const FDetection& a, const FDetection& b) {
            float ix1 = std::max(float(a.x1_coord), float(b.x1_coord));
            float iy1 = std::max(float(a.y1_coord), float(b.y1_coord));
            float ix2 = std::min(float(a.x2_coord), float(b.x2_coord));
            float iy2 = std::min(float(a.y2_coord), float(b.y2_coord));
            if (ix1 >= ix2 || iy1 >= iy2) return 0.0f;

            float inter = (ix2 - ix1) * (iy2 - iy1);
            float area_a = float(a.x2_coord - a.x1_coord) *
                float(a.y2_coord - a.y1_coord);
            float area_b = float(b.x2_coord - b.x1_coord) *
                float(b.y2_coord - b.y1_coord);
            float u = area_a + area_b - inter;
            return (u > 0) ? (inter / u) : 0.0f;
        }

        static float center_x(const FDetection& d) {
            return (d.x1_coord + d.x2_coord) * 0.5f;
        }
        static float center_y(const FDetection& d) {
            return (d.y1_coord + d.y2_coord) * 0.5f;
        }

    private:
        FIoUTrackerConfig m_config;
        std::vector<FTrack> m_tracks;
        int m_next_id = 0;
    };

} // namespace neural
} // namespace varan