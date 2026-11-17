// Самопроверка камеры на плате: JSON <-> FV4l2Source, source, границы, режимы драйвера, ошибки v4l2src: g++ -std=c++20 -Iinclude -I/c/local/boost_1_89_0 checks/v4l2-source-check.cpp -o /tmp/v4l2-source-check && /tmp/v4l2-source-check

#include <boost/json/src.hpp>

#include <cstdio>
#include <cstdlib>

#include "nvr/stream-error.h"
#include "nvr/v4l2-source.h"
#include "utility/v4l2-devices.h"

using namespace varan::nvr;

#define CHECK(cond) do { if (!(cond)) { std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); std::exit(1); } } while (0)

static bool throws(const char* text) {
    try { camera_v4l2_from_json(boost::json::parse(text).as_object()); } catch (const std::exception&) { return true; }
    return false;
}

static FV4l2Source usb() {
    FV4l2Source source;
    source.device = "/dev/v4l/by-path/platform-xhci-hcd.0.auto-usb-0:1:1.0-video-index0";
    source.format = "MJPG";
    source.width = 1280;
    source.height = 720;
    source.fps = 30;
    return source;
}

static void roundtrip() {
    auto source = usb();
    source.rotation = 270;
    source.swap_uv = true;
    source.bitrate = 2500;
    source.gop = 2;

    boost::json::object camera;
    camera_v4l2_to_json(source, camera);
    const auto back = camera_v4l2_from_json(boost::json::parse(boost::json::serialize(camera)).as_object());
    CHECK(back && back->device == source.device && back->format == "MJPG");
    CHECK(back->width == 1280 && back->height == 720 && back->fps == 30);
    CHECK(back->rotation == 270 && back->swap_uv && back->bitrate == 2500 && back->gop == 2);

    boost::json::object network;
    camera_v4l2_to_json(std::nullopt, network);
    CHECK(network.at("source").as_string() == "rtsp" && !network.contains("v4l2"));
    std::puts("roundtrip: OK");
}

static void source_field() {
    CHECK(!camera_v4l2_from_json(boost::json::parse(R"({"id":"camera_1"})").as_object()));
    CHECK(!camera_v4l2_from_json(boost::json::parse(R"({"source":"rtsp"})").as_object()));
    CHECK(throws(R"({"source":"usb"})"));
    CHECK(throws(R"({"source":"v4l2"})"));
    CHECK(throws(R"({"source":"v4l2","v4l2":{"device":"rkisp_mainpath","format":"UYVY","width":1920,"height":1408}})"));
    CHECK(throws(R"({"source":"v4l2","v4l2":{"device":"rkisp_mainpath","format":"UYVY","width":"1920","height":1408,"fps":20}})"));

    const auto csi = camera_v4l2_from_json(boost::json::parse(
        R"({"source":"v4l2","v4l2":{"device":"rkisp_mainpath","format":"UYVY","width":1920,"height":1408,"fps":20}})").as_object());
    CHECK(csi && csi->rotation == 0 && !csi->swap_uv && csi->bitrate == 0 && csi->gop == 1);
    std::puts("source field: OK");
}

static void limits() {
    auto source = usb();
    CHECK(check_v4l2_source(source).empty());

    for (const char* format : { "YUYV", "UYVY", "NV12", "MJPG" }) {
        source.format = format;
        CHECK(check_v4l2_source(source).empty());
    }
    source.format = "H264";
    CHECK(!check_v4l2_source(source).empty());
    source.format = "YUYV";

    source.device.clear();
    CHECK(!check_v4l2_source(source).empty());
    source = usb();

    source.width = 1281;
    CHECK(!check_v4l2_source(source).empty());
    source.width = 0;
    CHECK(!check_v4l2_source(source).empty());
    source = usb();

    source.fps = 0;
    CHECK(!check_v4l2_source(source).empty());
    source.fps = 121;
    CHECK(!check_v4l2_source(source).empty());
    source = usb();

    source.rotation = 45;
    CHECK(!check_v4l2_source(source).empty());
    source.rotation = 180;
    CHECK(check_v4l2_source(source).empty());

    // YUYV и UYVY поворачивает только сенсор CSI на 180
    source.format = "YUYV";
    CHECK(!check_v4l2_source(source).empty());
    source.rotation = 0;
    CHECK(check_v4l2_source(source).empty());
    source.device = "rkisp_mainpath";
    source.format = "UYVY";
    source.rotation = 180;
    CHECK(check_v4l2_source(source).empty());
    source.rotation = 90;
    CHECK(!check_v4l2_source(source).empty());
    source.format = "NV12";
    CHECK(check_v4l2_source(source).empty());
    source = usb();
    source.rotation = 270;
    CHECK(check_v4l2_source(source).empty());

    source.bitrate = -1;
    CHECK(!check_v4l2_source(source).empty());
    source.bitrate = 0;

    source.gop = 0;
    CHECK(!check_v4l2_source(source).empty());
    source.gop = 61;
    CHECK(!check_v4l2_source(source).empty());
    source.gop = 60;
    CHECK(check_v4l2_source(source).empty());
    std::puts("limits: OK");
}

static void streams() {
    std::map<std::string, FPipelineConfig> pipelines;
    CHECK(!check_v4l2_streams(pipelines).empty());
    pipelines["stream_1"] = {};
    CHECK(check_v4l2_streams(pipelines).empty());
    pipelines["stream_2"] = {};
    CHECK(!check_v4l2_streams(pipelines).empty());
    pipelines.erase("stream_1");
    CHECK(!check_v4l2_streams(pipelines).empty());
    std::puts("streams: OK");
}

static void modes() {
    FV4l2Camera camera;
    camera.device = "/dev/v4l/by-path/usb";
    FV4l2Format mjpg;
    mjpg.format = "MJPG";
    mjpg.sizes = { { 1920, 1080, { 30, 15 } }, { 1280, 720, { 60, 30 } } };
    FV4l2Format yuyv;
    yuyv.format = "YUYV";
    yuyv.sizes = { { 640, 480, {} } };
    camera.formats = { mjpg, yuyv };

    auto source = usb();
    CHECK(check_v4l2_mode(camera, source).empty());
    source.fps = 25;
    CHECK(!check_v4l2_mode(camera, source).empty());
    source.fps = 60;
    CHECK(check_v4l2_mode(camera, source).empty());
    source.width = 800;
    source.height = 600;
    CHECK(!check_v4l2_mode(camera, source).empty());

    source.format = "YUYV";
    source.width = 640;
    source.height = 480;
    source.fps = 7;
    CHECK(check_v4l2_mode(camera, source).empty());
    source.format = "NV12";
    CHECK(!check_v4l2_mode(camera, source).empty());

    FV4l2Camera isp;
    isp.csi = true;
    FV4l2Format uyvy;
    uyvy.format = "UYVY";
    uyvy.stepwise = true;
    uyvy.min_width = 32;
    uyvy.max_width = 3280;
    uyvy.step_width = 8;
    uyvy.min_height = 32;
    uyvy.max_height = 2464;
    uyvy.step_height = 8;
    isp.formats = { uyvy };

    FV4l2Source csi;
    csi.device = "rkisp_mainpath";
    csi.format = "UYVY";
    csi.width = 1920;
    csi.height = 1408;
    csi.fps = 20;
    CHECK(check_v4l2_mode(isp, csi).empty());
    csi.width = 1922;
    CHECK(!check_v4l2_mode(isp, csi).empty());
    csi.width = 4096;
    CHECK(!check_v4l2_mode(isp, csi).empty());
    std::puts("modes: OK");
}

static void errors() {
    CHECK(classify_v4l2_error("Device '/dev/video21' is busy") == varan::signaling::CODE_V4L2_BUSY);
    CHECK(classify_v4l2_error("Cannot identify device '/dev/video21'.") == varan::signaling::CODE_V4L2_NOT_FOUND);
    CHECK(classify_v4l2_error("Could not read from resource.", "poll error 1: No such device (19)") == varan::signaling::CODE_V4L2_NOT_FOUND);
    CHECK(classify_v4l2_error("Internal data stream error.", "streaming stopped, reason not-negotiated (-4)") == varan::signaling::CODE_V4L2_FORMAT);
    CHECK(classify_v4l2_error("Device '/dev/video0' cannot capture at 4096x2160") == varan::signaling::CODE_V4L2_FORMAT);
    CHECK(classify_v4l2_error("Internal data flow error.") == varan::signaling::CODE_GST_ERROR);
    std::puts("errors: OK");
}

static void listing() {
    FV4l2Camera camera;
    camera.device = "rkisp_mainpath";
    camera.node = "/dev/video0";
    camera.name = "rkisp_mainpath";
    camera.csi = true;
    camera.sensor = "IMX219";
    FV4l2Format range;
    range.format = "UYVY";
    range.stepwise = true;
    range.max_width = 3280;
    FV4l2Format sizes;
    sizes.format = "NV12";
    sizes.sizes = { { 1920, 1080, { 30 } } };
    camera.formats = { range, sizes };

    const auto json = v4l2_camera_to_json(camera);
    CHECK(json.at("kind").as_string() == "csi" && json.at("node").as_string() == "/dev/video0");
    CHECK(json.at("sensor").as_string() == "IMX219");
    const auto& formats = json.at("formats").as_array();
    CHECK(formats.size() == 2);
    CHECK(formats[0].as_object().at("range").as_object().at("max_width").as_int64() == 3280);
    CHECK(!formats[0].as_object().contains("sizes"));
    CHECK(formats[1].as_object().at("sizes").as_array()[0].as_object().at("fps").as_array()[0].as_int64() == 30);
    std::puts("listing: OK");
}

int main() {
    roundtrip();
    source_field();
    limits();
    streams();
    modes();
    errors();
    listing();
    std::puts("all OK");
    return 0;
}
