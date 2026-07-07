#pragma once

#include <string>
#include <vector>
#include <mutex>
#include <condition_variable>
#include <queue>

#include "neural/yolov8.h"
#include "neural/utility.h"
#include "neural/rknn-context-guard.h"
#include "logger.h"

namespace varan {
    namespace neural {

        /*
            Classifier — один экземпляр модели, занимающий N конкретных ядер NPU.

            npu_cores — список индексов 0..2. Пустой = все три (0, 1, 2).
            Каждое ядро держит свой RKNN-контекст (через rknn_dup_context),
            память весов модели разделяется.

            RAII: все контексты хранятся в RknnContextGuard, автоматически
            освобождаются при разрушении Classifier. Утечки при исключениях
            в конструкторе исключены.

            Параллельный вызов classify() из нескольких потоков работает:
            берётся свободный контекст из пула, по окончании возвращается обратно.
        */
        class Classifier {
        public:
            Classifier(
                const std::string& model_path,
                const std::vector<FClassInfo>& classes,
                float threshold_nms,
                float confidence_threshold,
                const std::vector<int>& npu_cores,
                ULogger* logger = nullptr
            );

            ~Classifier() = default;  // RknnContextGuard всё освободит сам

            Classifier(const Classifier&) = delete;
            Classifier& operator=(const Classifier&) = delete;

            yolo_inference_result_t classify(const cv::Mat& frame, std::vector<uint8_t>& drawable_mask);

            const std::vector<int>& occupied_cores() const { return m_occupied_cores; }
            int num_workers() const { return static_cast<int>(m_contexts.size()); }

        private:
            rknn_app_context_t* acquire_context();
            void release_context(rknn_app_context_t* ctx);

        private:
            // RAII: каждый элемент автоматически освобождает свой контекст.
            // m_contexts[0] — master, остальные — дубликаты.
            std::vector<RknnContextGuard>   m_contexts;
            std::vector<int>                m_occupied_cores;

            std::mutex                      m_pool_mutex;
            std::condition_variable         m_pool_cv;
            std::queue<rknn_app_context_t*> m_pool;  // указатели внутрь m_contexts

            std::vector<FClassInfo>         m_classes;
            float                           m_threshold_nms;
            float                           m_confidence_threshold;
            ULogger* m_logger;
        };

    } // namespace neural
} // namespace varan