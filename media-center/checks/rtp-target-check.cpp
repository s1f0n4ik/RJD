// Самопроверка цели RTP-трансляции: JSON <-> FRtpTarget и допустимые значения: g++ -std=c++20 -Iinclude -I/c/local/boost_1_89_0 checks/rtp-target-check.cpp -o /tmp/rtp-target-check && /tmp/rtp-target-check

#include <boost/json/src.hpp>

#include <cstdio>
#include <cstdlib>

#include "nvr/rtp-target.h"

using namespace varan::nvr;

#define CHECK(cond) do { if (!(cond)) { std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); std::exit(1); } } while (0)

static void roundtrip() {
    FRtpTarget rtp;
    rtp.host = "203.0.113.7";
    rtp.port = 5004;
    rtp.transcode = true;
    rtp.width = 640;
    rtp.height = 360;
    rtp.bitrate = 800;
    rtp.qp_max = 36;

    const auto back = rtp_from_json(boost::json::parse(boost::json::serialize(rtp_to_json(rtp))).as_object());
    CHECK(back.host == rtp.host && back.port == rtp.port && back.transcode);
    CHECK(back.width == 640 && back.height == 360 && back.bitrate == 800 && back.qp_max == 36);
    std::puts("roundtrip: OK");
}

static void defaults() {
    const auto rtp = rtp_from_json(boost::json::parse(R"({"host":"a.example","port":1234})").as_object());
    CHECK(!rtp.transcode && rtp.width == 0 && rtp.height == 0 && rtp.bitrate == 0 && rtp.qp_max == 0);
    CHECK(check_rtp_target(rtp).empty());

    bool thrown = false;
    try { rtp_from_json(boost::json::parse(R"({"mode":"relay"})").as_object()); } catch (const std::exception&) { thrown = true; }
    CHECK(thrown);
    std::puts("defaults: OK");
}

static void limits() {
    FRtpTarget rtp;
    CHECK(!check_rtp_target(rtp).empty());

    rtp.host = "203.0.113.7";
    rtp.port = 0;
    CHECK(!check_rtp_target(rtp).empty());
    rtp.port = 65536;
    CHECK(!check_rtp_target(rtp).empty());
    rtp.port = 5004;
    CHECK(check_rtp_target(rtp).empty());

    rtp.qp_max = 52;
    CHECK(!check_rtp_target(rtp).empty());
    rtp.qp_max = 51;
    rtp.transcode = true;
    rtp.width = 64;
    CHECK(!check_rtp_target(rtp).empty());
    rtp.width = 96;
    rtp.height = 64;
    CHECK(check_rtp_target(rtp).empty());
    std::puts("limits: OK");
}

static void purposes() {
    FStreamPurposes purposes;
    CHECK(purposes.empty());
    purposes.add(*purpose_from_string("rtp"));
    CHECK(purposes.rtp && !purposes.empty() && !purposes.needs_decode());
    CHECK(purposes.to_string() == "rtp");
    std::puts("purposes: OK");
}

int main() {
    roundtrip();
    defaults();
    limits();
    purposes();
    std::puts("all OK");
    return 0;
}
