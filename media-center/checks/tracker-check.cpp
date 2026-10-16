// Самопроверка трекера Калман + IoU на синтетических сценах: g++ -std=c++20 -Iinclude checks/tracker-check.cpp $(pkg-config --cflags --libs opencv4) -o /tmp/tracker-check && /tmp/tracker-check

#include <cstdio>
#include <cstdlib>
#include <cmath>

#include "neural/tracker/kalman-iou-tracker.h"

using namespace varan::neural;
using clock_type = std::chrono::steady_clock;

#define CHECK(cond) do { if (!(cond)) { std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); std::exit(1); } } while (0)

static std::atomic<std::int64_t> g_ids{ 1 };
static const clock_type::time_point g_t0 = clock_type::now();

static FDetection box(float cx, float cy, int w, int h, int cls = 0, float conf = 0.9f) {
    FDetection d{};
    d.x1_coord = static_cast<int>(std::lround(cx - w / 2.f));
    d.y1_coord = static_cast<int>(std::lround(cy - h / 2.f));
    d.x2_coord = d.x1_coord + w;
    d.y2_coord = d.y1_coord + h;
    d.class_id = cls;
    d.confidence = conf;
    return d;
}

static bool has(const FTrackerUpdateResult& r, ETrackEvent e) {
    for (const auto& x : r.events) if (x.event == e) return true;
    return false;
}

struct FRun {
    UKalmanIoUTracker tracker;
    explicit FRun(const FKalmanIoUTrackerConfig& c) : tracker(c, &g_ids) {}

    FTrackerUpdateResult step(float s, const std::vector<FDetection>& dets, std::vector<cv::Rect2f> visible = {}) {
        const auto at = g_t0 + std::chrono::duration_cast<clock_type::duration>(std::chrono::duration<float>(s));
        return tracker.update(dets, FTrackerFrame{ 1920, 1080, at, std::move(visible) });
    }

    const FTrack& only() {
        CHECK(tracker.tracks().size() == 1);
        return tracker.tracks()[0];
    }
};

static FKalmanIoUTrackerConfig base() {
    FKalmanIoUTrackerConfig c;
    c.confidence = 0.5f;
    return c;
}

// Выпавшие полотна и пропуски детекций: номер держится, предсказание едет за объектом
static void dropped_and_missed() {
    FRun r(base());
    const auto x = [](float s) { return 100.f + 600.f * s; };
    std::int64_t id = -1;
    for (int k = 0; k < 50; ++k) {
        if (k >= 20 && k < 25) continue;
        const float s = k * 0.04f;
        const auto res = r.step(s, { box(x(s), 500, 100, 60) });
        CHECK(!has(res, ETrackEvent::LOST));
        if (k == 2) { CHECK(has(res, ETrackEvent::CONFIRMED)); id = r.only().id; }
        if (k > 2) CHECK(r.only().id == id && r.only().state == ETrackState::CONFIRMED);
    }
    for (int k = 50; k < 55; ++k) {
        const float s = k * 0.04f;
        const auto res = r.step(s, {});
        CHECK(has(res, ETrackEvent::LOST) == (k == 50));
        const auto& t = r.only();
        CHECK(t.state == ETrackState::LOST && t.lost_frames == k - 49);
        CHECK(std::abs((t.detection.x1_coord + t.detection.x2_coord) / 2.f - x(s)) < 10.f);
    }
    const auto res = r.step(55 * 0.04f, { box(x(55 * 0.04f), 500, 100, 60) });
    CHECK(has(res, ETrackEvent::RECOVERED) && r.only().id == id && r.only().state == ETrackState::CONFIRMED);
}

// Слабые детекции держат трек в перекрытии и не рождают новых
static void low_confidence_bridge() {
    FRun r(base());
    for (int k = 0; k < 30; ++k) {
        const float s = k * 0.04f;
        const bool occluded = k >= 10 && k < 20;
        std::vector<FDetection> dets{ box(300 + 200 * s, 500, 100, 60, 0, occluded ? 0.2f : 0.9f) };
        if (k == 15) dets.push_back(box(1500, 200, 80, 80, 0, 0.2f));
        const auto res = r.step(s, dets);
        CHECK(!has(res, ETrackEvent::LOST));
        if (k >= 2) CHECK(r.only().state == ETrackState::CONFIRMED);
    }
}

// Центр предсказания вышел из окна — трек удалён сразу, а не через max_lost_s
static void exit_window() {
    FRun r(base());
    const std::vector<cv::Rect2f> window{ cv::Rect2f(0, 0, 1000, 1080) };
    bool removed = false;
    for (int k = 0; k < 30 && !removed; ++k) {
        const float s = k * 0.04f;
        const float cx = 500 + 600 * s;
        const auto res = r.step(s, cx < 1000 ? std::vector<FDetection>{ box(cx, 500, 100, 60) } : std::vector<FDetection>{}, window);
        removed = has(res, ETrackEvent::REMOVED);
        if (removed) CHECK(k <= 23 && r.tracker.tracks().empty());
    }
    CHECK(removed);
}

// Смена класса на кадр: по суперклассу трек и класс сохраняются, по классу трек рвётся
static void class_flip() {
    auto c = base();
    c.group_of_class = { -2, -2 };
    for (const auto mode : { EMatchBy::SUPERCLASS, EMatchBy::CLASS }) {
        c.match_by = mode;
        FRun r(c);
        for (int k = 0; k < 10; ++k) r.step(k * 0.04f, { box(500, 500, 100, 100, 0) });
        const auto id = r.only().id;
        const auto res = r.step(0.4f, { box(500, 500, 100, 100, 1, 0.6f) });
        if (mode == EMatchBy::SUPERCLASS) {
            CHECK(r.only().id == id && r.only().class_id == 0 && !has(res, ETrackEvent::CREATED));
        }
        else {
            CHECK(has(res, ETrackEvent::LOST) && has(res, ETrackEvent::CREATED) && r.tracker.tracks().size() == 2);
        }
    }
}

// Потерянный трек удаляется по сроку max_lost_s
static void lost_timeout() {
    FRun r(base());
    for (int k = 0; k < 5; ++k) r.step(k * 0.04f, { box(500, 500, 100, 100) });
    for (int k = 5; k < 40; ++k) {
        const float s = k * 0.04f;
        const auto res = r.step(s, {});
        if (has(res, ETrackEvent::REMOVED)) {
            CHECK(s > 1.1f && s <= 1.25f);
            return;
        }
    }
    CHECK(false);
}

// «Движение» по накопленному сдвигу: 1 px за кадр даёт одно событие на 110 px
static void accumulated_move() {
    FRun r(base());
    int updates = 0;
    for (int k = 0; k < 150; ++k) {
        const auto res = r.step(k * 0.04f, { box(100.f + k, 500, 100, 100) });
        updates += has(res, ETrackEvent::UPDATED);
    }
    CHECK(updates == 1);
}

static bool sized(const FTrack& t, int w, int h) {
    return std::abs(t.detection.x2_coord - t.detection.x1_coord - w) <= 2 && std::abs(t.detection.y2_coord - t.detection.y1_coord - h) <= 2;
}

// Рамка вдвое крупнее трека проходит IoU, но не похожесть размеров: трек в потере с прежним размером, уверенная рождает свой трек
static void size_jump() {
    struct FJunk { int w; int h; float conf; };
    for (const auto junk : { FJunk{ 150, 90, 0.9f }, FJunk{ 167, 48, 0.2f } }) {
        for (const float gate : { 0.f, 0.5f }) {
            auto c = base();
            c.min_size_similarity = gate;
            FRun r(c);
            for (int k = 0; k < 10; ++k) r.step(k * 0.04f, { box(500, 500, 100, 60) });
            const auto id = r.only().id;
            const auto res = r.step(0.4f, { box(500, 500, junk.w, junk.h, 0, junk.conf) });
            if (gate == 0.f) {
                CHECK(!has(res, ETrackEvent::LOST) && r.only().id == id);
                continue;
            }
            CHECK(has(res, ETrackEvent::LOST) && has(res, ETrackEvent::CREATED) == (junk.conf >= 0.5f));
            const auto& t = r.tracker.tracks()[0];
            CHECK(t.id == id && t.state == ETrackState::LOST && sized(t, 100, 60));
        }
    }
}

// Слабые рамки другого размера держат трек, но размер в фильтре остаётся от уверенной
static void weak_keeps_size() {
    FRun r(base());
    for (int k = 0; k < 10; ++k) r.step(k * 0.04f, { box(500, 500, 100, 60) });
    for (int k = 10; k < 20; ++k) {
        const auto res = r.step(k * 0.04f, { box(500, 500, 130, 75, 0, 0.2f) });
        CHECK(!has(res, ETrackEvent::LOST) && r.only().state == ETrackState::CONFIRMED);
    }
    r.step(0.8f, {});
    CHECK(r.only().state == ETrackState::LOST && sized(r.only(), 100, 60));
}

int main() {
    dropped_and_missed();
    low_confidence_bridge();
    exit_window();
    class_flip();
    lost_timeout();
    accumulated_move();
    size_jump();
    weak_keeps_size();
    std::puts("tracker-check: OK");
    return 0;
}
