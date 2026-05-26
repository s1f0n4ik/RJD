#include "neural/classifier.h"
#include "neural/yolov8.h"
#include "neural/image-utils.h"

#include <cstring>
#include <chrono>
#include <stdexcept>

namespace varan {
namespace neural {

    Classifier::Classifier(
        const std::string& model_path,
        const std::vector<FClassInfo>& classes,
        float threshold_nms,
        float confidence_threshold,
        ULogger* logger)
        : m_classes(classes)
        , m_threshold_nms(threshold_nms)
        , m_confidence_threshold(confidence_threshold)
        , m_logger(logger)
    {
        std::memset(&rknn_app_ctx, 0, sizeof(rknn_app_context_t));

        int ret = init_yolov8_model(model_path, &rknn_app_ctx);
        if (ret != 0) {
            if (m_logger) m_logger->error("Classifier: init_yolov8_model fail! ret=" +
                std::to_string(ret) + " model_path=" + model_path);
            throw std::runtime_error("Classifier: model init failed: " + model_path);
        }
        if (m_logger) m_logger->info("Classifier: loaded model " + model_path +
            " (input=" + std::to_string(rknn_app_ctx.model_width) + "x" +
            std::to_string(rknn_app_ctx.model_height) + ")");
    }

    Classifier::~Classifier() {
        int ret = release_yolov8_model(&rknn_app_ctx);
        if (ret != 0 && m_logger) {
            m_logger->warn("Classifier: release_yolov8_model ret=" + std::to_string(ret));
        }
    }

    yolo_inference_result_t Classifier::classify(const cv::Mat& frame,
        std::vector<uint8_t>& drawable_mask)
    {
        yolo_inference_result_t result;

        if (frame.empty()) {
            if (m_logger) m_logger->trace("classify(): empty frame");
            return result;
        }

        if (m_logger) {
            m_logger->trace("classify(): type=" + std::to_string(frame.type()) +
                " channels=" + std::to_string(frame.channels()) +
                " " + std::to_string(frame.cols) + "x" + std::to_string(frame.rows));
        }

        // Нормализуем вход к BGR 3-канальному cv::Mat.
        // Внутри inference_yolo_rknn будет letterbox через resize_with_aspect_ratio
        // и затем BGR→RGB для модели.
        cv::Mat src_bgr;
        if (frame.channels() == 4) {
            // RGBA или BGRA. Если у тебя RGBA — RGBA2BGR; если BGRA — COLOR_BGRA2BGR.
            // Поправь под свой реальный вход.
            cv::cvtColor(frame, src_bgr, cv::COLOR_RGBA2BGR);
        }
        else if (frame.channels() == 3) {
            src_bgr = frame;  // Будем считать что приходит BGR
        }
        else {
            if (m_logger) m_logger->warn("classify(): unsupported channels=" +
                std::to_string(frame.channels()));
            return result;
        }

        const auto t0 = std::chrono::steady_clock::now();

        int ret = inference_yolo_rknn(
            &rknn_app_ctx,
            src_bgr,
            m_classes,
            m_threshold_nms,
            m_confidence_threshold,
            result,
            m_logger
        );

        const auto t1 = std::chrono::steady_clock::now();
        if (m_logger) {
            const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
            m_logger->trace("classify(): infer=" + std::to_string(ms) + "ms, det=" +
                std::to_string(result.detections.size()));
        }

        if (ret != 0) return result;

        drawable_mask = std::move(result.mask);
        return result;
    }

} // namespace neural
} // namespace varan