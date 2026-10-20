// Самопроверка зон: доли рамки и маски, порог 0, приоритет, вход и выход устойчивой зоны: g++ -std=c++20 -Iinclude -I3rdparty/boost/include checks/zone-check.cpp $(pkg-config --cflags --libs opencv4) -o /tmp/zone-check && /tmp/zone-check

#include <cstdio>
#include <cstdlib>

#include "neural/zone-map.h"

using namespace varan::neural;
using clock_type = std::chrono::steady_clock;

#define CHECK(cond) do { if (!(cond)) { std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); std::exit(1); } } while (0)

static const cv::Size kFrame(1280, 720);

static FDetection box(int x1, int y1, int x2, int y2) {
    FDetection d{};
    d.x1_coord = x1;
    d.y1_coord = y1;
    d.x2_coord = x2;
    d.y2_coord = y2;
    return d;
}

static FZoneInfo zone(int id, float threshold) {
    FZoneInfo z;
    z.id = id;
    z.threshold = threshold;
    return z;
}

static FZonePolygon rect(int zone_id, float x1, float y1, float x2, float y2) {
    return FZonePolygon{ zone_id, { { x1, y1 }, { x2, y1 }, { x2, y2 }, { x1, y2 } } };
}

static clock_type::time_point at(double s) {
    static const auto t0 = clock_type::now();
    return t0 + std::chrono::duration_cast<clock_type::duration>(std::chrono::duration<double>(s));
}

static void box_share() {
    // Зона 1 — левая половина кадра
    const std::vector<FZonePolygon> left{ rect(1, 0.f, 0.f, 0.5f, 1.f) };
    const UZoneMap low({ zone(1, 0.1f) }, left, kFrame);
    const UZoneMap high({ zone(1, 0.3f) }, left, kFrame);
    CHECK(low.zone_of(box(100, 100, 300, 300)) == 1);
    // 20 % рамки в зоне: проходит 10 %, не проходит 30 %
    CHECK(low.zone_of(box(600, 100, 800, 300)) == 1);
    CHECK(high.zone_of(box(600, 100, 800, 300)) == 0);
    CHECK(low.zone_of(box(900, 100, 1100, 300)) == 0);
    std::puts("box_share: OK");
}

static void zero_threshold() {
    const std::vector<FZonePolygon> left{ rect(1, 0.f, 0.f, 0.5f, 1.f) };
    const UZoneMap any({ zone(1, 0.f) }, left, kFrame);
    const UZoneMap half({ zone(1, 0.5f) }, left, kFrame);
    // Рамка заходит в зону на 4 пикселя
    CHECK(any.zone_of(box(636, 100, 900, 300)) == 1);
    CHECK(half.zone_of(box(636, 100, 900, 300)) == 0);
    CHECK(any.zone_of(box(660, 100, 900, 300)) == 0);
    std::puts("zero_threshold: OK");
}

static void priority() {
    // Зона 1 — квадрат в центре, зона 2 — весь кадр
    const std::vector<FZonePolygon> polygons{ rect(1, 0.4f, 0.4f, 0.6f, 0.6f), rect(2, 0.f, 0.f, 1.f, 1.f) };
    const UZoneMap first({ zone(1, 0.5f), zone(2, 0.5f) }, polygons, kFrame);
    CHECK(first.zone_of(box(560, 320, 720, 400)) == 1);
    CHECK(first.zone_of(box(100, 100, 200, 200)) == 2);
    // Каталог наоборот: зона 2 выше и накрывает всё
    const UZoneMap second({ zone(2, 0.5f), zone(1, 0.5f) }, polygons, kFrame);
    CHECK(second.zone_of(box(560, 320, 720, 400)) == 2);
    // Зоны без многоугольников на камере пропускаются
    const UZoneMap missing({ zone(3, 0.f), zone(1, 0.5f) }, polygons, kFrame);
    CHECK(missing.zone_of(box(560, 320, 720, 400)) == 1);
    std::puts("priority: OK");
}

static void mask_share() {
    const std::vector<FZonePolygon> left{ rect(1, 0.f, 0.f, 0.5f, 1.f) };
    const UZoneMap map({ zone(1, 0.1f) }, left, kFrame);
    // Рамка поровну в обеих половинах, маска только справа
    FDetection right = box(440, 100, 840, 300);
    right.polygons = { { { 700, 120 }, { 830, 120 }, { 830, 290 }, { 700, 290 } } };
    CHECK(map.zone_of(right) == 0);
    FDetection left_mask = box(440, 100, 840, 300);
    left_mask.polygons = { { { 450, 120 }, { 600, 120 }, { 600, 290 }, { 450, 290 } } };
    CHECK(map.zone_of(left_mask) == 1);
    // Контур целиком за рамкой — считается по рамке
    FDetection outside = box(440, 100, 840, 300);
    outside.polygons = { { { 10, 10 }, { 20, 10 }, { 20, 20 } } };
    CHECK(map.zone_of(outside) == 1);
    std::puts("mask_share: OK");
}

static void enter_leave() {
    const std::vector<FZoneInfo> catalog{ zone(1, 0.f), zone(2, 0.f) };
    FZoneTrack s;
    s.zone = 2;
    s.held = at(0);
    // Вверх только на втором кадре подряд
    CHECK(step_zone(s, 1, at(0.04), catalog, 2, 1.f) == EZoneStep::SAME && s.zone == 2);
    CHECK(step_zone(s, 1, at(0.08), catalog, 2, 1.f) == EZoneStep::UP && s.zone == 1);
    // Одиночный выброс вверх сбрасывается кадром ниже
    FZoneTrack spike;
    spike.zone = 2;
    spike.held = at(0);
    step_zone(spike, 1, at(0.04), catalog, 2, 1.f);
    step_zone(spike, 2, at(0.08), catalog, 2, 1.f);
    CHECK(step_zone(spike, 1, at(0.12), catalog, 2, 1.f) == EZoneStep::SAME && spike.zone == 2);
    // Вниз только через секунду без зоны 1
    CHECK(step_zone(s, 2, at(0.5), catalog, 2, 1.f) == EZoneStep::SAME && s.zone == 1);
    CHECK(step_zone(s, 2, at(1.1), catalog, 2, 1.f) == EZoneStep::DOWN && s.zone == 2);
    std::puts("enter_leave: OK");
}

static void border_flicker() {
    const std::vector<FZoneInfo> catalog{ zone(1, 0.f), zone(2, 0.f) };
    // Дрожь на границе 1/2 из зоны 1: зона держится, смен нет
    FZoneTrack s;
    s.zone = 1;
    s.held = at(0);
    for (int i = 1; i <= 50; ++i)
        CHECK(step_zone(s, i % 2 ? 2 : 1, at(i * 0.1), catalog, 2, 1.f) == EZoneStep::SAME && s.zone == 1);
    // Из вне зон на стыке 1/2: поднимается в нижнюю из увиденных, потом выше
    FZoneTrack out;
    out.zone = 0;
    out.held = at(0);
    step_zone(out, 2, at(0.04), catalog, 2, 1.f);
    CHECK(step_zone(out, 1, at(0.08), catalog, 2, 1.f) == EZoneStep::UP && out.zone == 2);
    step_zone(out, 1, at(0.12), catalog, 2, 1.f);
    CHECK(step_zone(out, 1, at(0.16), catalog, 2, 1.f) == EZoneStep::UP && out.zone == 1);
    std::puts("border_flicker: OK");
}

int main() {
    box_share();
    zero_threshold();
    priority();
    mask_share();
    enter_leave();
    border_flicker();
    std::puts("zone-check: OK");
    return 0;
}
