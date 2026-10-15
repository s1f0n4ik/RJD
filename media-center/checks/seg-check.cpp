// Разбор seg-модели на снимке, JSON в stdout: g++ -std=c++20 -O2 -Iinclude -I3rdparty/rknn/include -I3rdparty/boost/include checks/seg-check.cpp src/neural/postprocess.cc src/neural/yolov8.cc $(pkg-config --cflags --libs opencv4) -L3rdparty/rknn/lib -lrknnrt -o /tmp/seg-check && /tmp/seg-check <model.rknn> <image.jpg> > ours.json
// Сравнение с эталоном ultralytics: checks/seg-ref.py

#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

#include <opencv2/opencv.hpp>

#include "neural/yolov8.h"

using namespace varan::neural;

int main(int argc, char** argv)
{
    if (argc < 3) {
        std::fprintf(stderr, "usage: seg-check <model.rknn> <image>\n");
        return 2;
    }

    rknn_app_context_t ctx{};
    if (init_yolov8_model(argv[1], &ctx) != 0) return 1;
    if (!is_segmentation(ctx.layout)) {
        std::fprintf(stderr, "FAIL: not a segmentation layout: %s\n", output_layout_name(ctx.layout));
        return 1;
    }

    // BGR, как отдаёт классификатор
    const cv::Mat image = cv::imread(argv[2]);
    if (image.empty()) {
        std::fprintf(stderr, "FAIL: cannot read %s\n", argv[2]);
        return 1;
    }

    std::vector<FClassInfo> classes(ctx.model_class_count);
    for (size_t i = 0; i < classes.size(); ++i) classes[i].id = static_cast<int>(i);

    // Первый прогон прогревает NPU, второй замеряется
    yolo_inference_result_t result;
    inference_yolo_rknn(&ctx, image, classes, 0.45f, 0.25f, result, nullptr);
    result = {};
    const auto started = std::chrono::steady_clock::now();
    const int ret = inference_yolo_rknn(&ctx, image, classes, 0.45f, 0.25f, result, nullptr);
    const float ms = std::chrono::duration<float, std::milli>(std::chrono::steady_clock::now() - started).count();
    if (ret < 0) {
        std::fprintf(stderr, "FAIL: inference ret=%d\n", ret);
        return 1;
    }

    std::printf("{\"layout\":\"%s\",\"ms\":%.1f,\"detections\":[", output_layout_name(ctx.layout), ms);
    for (size_t i = 0; i < result.detections.size(); ++i) {
        const auto& d = result.detections[i];
        std::printf("%s{\"class\":%d,\"conf\":%.4f,\"box\":[%d,%d,%d,%d],\"polygons\":[", i ? "," : "",
            d.class_id, d.confidence, d.x1_coord, d.y1_coord, d.x2_coord, d.y2_coord);
        for (size_t j = 0; j < d.polygons.size(); ++j) {
            std::printf("%s[", j ? "," : "");
            for (size_t k = 0; k < d.polygons[j].size(); ++k)
                std::printf("%s%d,%d", k ? "," : "", d.polygons[j][k].x, d.polygons[j][k].y);
            std::printf("]");
        }
        std::printf("]}");
    }
    std::printf("]}\n");

    release_yolov8_model(&ctx);
    return 0;
}
