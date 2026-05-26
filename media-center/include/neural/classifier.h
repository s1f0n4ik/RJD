#ifndef ATTACHMENT_CLASSIFIER_CLASSIFIER_H
#define ATTACHMENT_CLASSIFIER_CLASSIFIER_H

#include <string>
#include <vector>
#include "yolov8.h"

#include "utility.h"
#include "logger.h"

namespace varan {
namespace neural {

    class Classifier {
    public:
        Classifier(
            const std::string& model_path,
            const std::vector<FClassInfo>& classes,
            float threshold__nms,
            float confidence_threshold,
            ULogger* logger = nullptr
        );

        ~Classifier();

        yolo_inference_result_t classify(const cv::Mat& frame, std::vector<uint8_t>& drawable_mask);
    private:
        rknn_app_context_t rknn_app_ctx;

        std::vector<FClassInfo> m_classes;

        float m_threshold_nms;
        float m_confidence_threshold;

        ULogger* m_logger;
    };

} // neural
} // varan

#endif //ATTACHMENT_CLASSIFIER_CLASSIFIER_H
