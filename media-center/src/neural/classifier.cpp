#include "neural/classifier.h"
#include "neural/yolov8.h"
#include "neural/image-utils.h"

#include <algorithm>
#include <chrono>

namespace varan {
    namespace neural {

        Classifier::Classifier(
            const std::string& model_path,
            const std::vector<FClassInfo>& classes,
            float threshold_nms,
            float confidence_threshold,
            int depth,
            ULogger* logger)
            : m_handle(UNpuPool::instance().attach(model_path, std::max(depth, 1), logger))
            , m_classes(classes)
            , m_threshold_nms(threshold_nms)
            , m_confidence_threshold(confidence_threshold)
            , m_logger(logger)
        {
            if (!m_logger) return;

            const int model_classes = m_handle->master().model_class_count;
            if (model_classes != static_cast<int>(m_classes.size()))
                m_logger->warn("Classifier: model has " + std::to_string(model_classes) +
                    " classes, configuration has " + std::to_string(m_classes.size()) +
                    " — using first " + std::to_string(std::min<int>(model_classes, m_classes.size())));

            // Номер канала тензора считается индексом класса, поэтому id обязаны идти 0..N-1
            for (size_t i = 0; i < m_classes.size(); ++i) {
                if (m_classes[i].id != static_cast<int>(i)) {
                    m_logger->warn("Classifier: class ids are not dense (index " + std::to_string(i) +
                        " has id " + std::to_string(m_classes[i].id) + "), channel order is used");
                    break;
                }
            }

            m_logger->info("Classifier: " + model_path + " depth=" + std::to_string(depth) +
                " actual=" + std::to_string(depth_actual()));
        }

        yolo_inference_result_t Classifier::classify(const cv::Mat& frame,
            std::vector<uint8_t>& drawable_mask)
        {
            yolo_inference_result_t result;
            if (frame.empty()) return result;

            cv::Mat src_bgr;
            if (frame.channels() == 4) {
                cv::cvtColor(frame, src_bgr, cv::COLOR_RGBA2BGR);
            }
            else if (frame.channels() == 3) {
                src_bgr = frame;
            }
            else {
                if (m_logger) m_logger->warn("classify(): channels=" +
                    std::to_string(frame.channels()));
                return result;
            }

            auto* ctx = m_handle->acquire();
            const auto t0 = std::chrono::steady_clock::now();

            int ret = inference_yolo_rknn(
                ctx, src_bgr,
                m_classes, m_threshold_nms, m_confidence_threshold,
                result, m_logger);

            const auto t1 = std::chrono::steady_clock::now();
            m_handle->release(ctx, ret < 0);

            if (m_logger) {
                const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
                m_logger->trace("classify(): infer=" + std::to_string(ms) + "ms, det=" +
                    std::to_string(result.detections.size()));
            }

            if (ret == 0) drawable_mask = std::move(result.mask);
            return result;
        }

    } // namespace neural
} // namespace varan
