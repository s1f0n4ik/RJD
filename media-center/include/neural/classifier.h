#pragma once

#include <string>
#include <vector>
#include <memory>

#include "neural/yolov8.h"
#include "neural/utility.h"
#include "neural/npu-pool.h"
#include "logger.h"

namespace varan {
    namespace neural {

        // Одна модель слота: ручка на группу контекстов пула + пороги и классы.
        // classify() можно звать из нескольких потоков — каждый вызов берёт
        // свободный контекст группы и возвращает его по окончании.
        class Classifier {
        public:
            // Бросает FNeuralError с кодом 6xxx, если модель не поднялась
            Classifier(
                const std::string& model_path,
                const std::vector<FClassInfo>& classes,
                float threshold_nms,
                float confidence_threshold,
                int depth,
                ULogger* logger = nullptr
            );

            Classifier(const Classifier&) = delete;
            Classifier& operator=(const Classifier&) = delete;

            yolo_inference_result_t classify(const cv::Mat& frame, std::vector<uint8_t>& drawable_mask);

            int depth_actual() const { return m_handle->depth_actual(); }
            const FModelInfo& info() const { return m_handle->info(); }
            const char* layout() const { return output_layout_name(m_handle->master().layout); }

        private:
            std::unique_ptr<UNpuPool::UHandle> m_handle;
            std::vector<FClassInfo>            m_classes;
            float                              m_threshold_nms;
            float                              m_confidence_threshold;
            ULogger* m_logger;
        };

    } // namespace neural
} // namespace varan
