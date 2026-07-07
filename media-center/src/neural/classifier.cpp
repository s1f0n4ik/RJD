#include "neural/classifier.h"
#include "neural/yolov8.h"
#include "neural/image-utils.h"

#include <cstring>
#include <chrono>
#include <stdexcept>
#include <algorithm>

namespace varan {
    namespace neural {

        static rknn_core_mask core_index_to_mask(int idx) {
            switch (idx) {
            case 0:  return RKNN_NPU_CORE_0;
            case 1:  return RKNN_NPU_CORE_1;
            case 2:  return RKNN_NPU_CORE_2;
            default: return RKNN_NPU_CORE_0;
            }
        }

        Classifier::Classifier(
            const std::string& model_path,
            const std::vector<FClassInfo>& classes,
            float threshold_nms,
            float confidence_threshold,
            const std::vector<int>& npu_cores,
            ULogger* logger)
            : m_classes(classes)
            , m_threshold_nms(threshold_nms)
            , m_confidence_threshold(confidence_threshold)
            , m_logger(logger)
        {
            // Дедупликация и валидация списка ядер.
            std::vector<int> cores = npu_cores;
            std::sort(cores.begin(), cores.end());
            cores.erase(std::unique(cores.begin(), cores.end()), cores.end());
            cores.erase(std::remove_if(cores.begin(), cores.end(),
                [](int c) { return c < 0 || c > 2; }), cores.end());

            if (cores.empty()) {
                cores = { 0, 1, 2 };
            }
            m_occupied_cores = cores;

            // 1) Master контекст — RAII, при исключении автоматически освободится.
            auto master = RknnContextGuard::create_master(model_path);
            master.set_core_mask(core_index_to_mask(cores[0]));

            // Сохраняем указатель на master для дублирования (до move!).
            const rknn_app_context_t master_snapshot = *master.get();

            m_contexts.reserve(cores.size());
            m_contexts.push_back(std::move(master));

            // 2) Дублируем для остальных ядер.
            //    Если create_duplicate бросит исключение — уже созданные
            //    контексты в m_contexts автоматически освободятся деструкторами.
            for (size_t i = 1; i < cores.size(); ++i) {
                try {
                    auto dup = RknnContextGuard::create_duplicate(master_snapshot);
                    dup.set_core_mask(core_index_to_mask(cores[i]));
                    m_contexts.push_back(std::move(dup));
                }
                catch (const std::exception& e) {
                    if (m_logger) m_logger->warn("Classifier: dup context #" +
                        std::to_string(i) + " failed: " + e.what() +
                        " — skipping core " + std::to_string(cores[i]));
                }
            }

            // 3) Заполняем пул указателями на «сырые» контексты.
            for (auto& guard : m_contexts) {
                m_pool.push(guard.get());
            }

            if (m_logger) {
                std::string cores_str;
                for (int c : m_occupied_cores) cores_str += std::to_string(c) + ",";
                if (!cores_str.empty()) cores_str.pop_back();

                auto* ctx = m_contexts[0].get();
                m_logger->info("Classifier: loaded " + model_path +
                    " (input=" + std::to_string(ctx->model_width) + "x" +
                    std::to_string(ctx->model_height) +
                    ", cores=[" + cores_str + "]" +
                    ", workers=" + std::to_string(m_contexts.size()) + ")");
            }
        }

        // Деструктор = default: vector<RknnContextGuard> сам вызовет
        // деструкторы каждого элемента в правильном порядке.

        rknn_app_context_t* Classifier::acquire_context() {
            std::unique_lock<std::mutex> lk(m_pool_mutex);
            m_pool_cv.wait(lk, [this] { return !m_pool.empty(); });
            auto* ctx = m_pool.front();
            m_pool.pop();
            return ctx;
        }

        void Classifier::release_context(rknn_app_context_t* ctx) {
            {
                std::lock_guard<std::mutex> lk(m_pool_mutex);
                m_pool.push(ctx);
            }
            m_pool_cv.notify_one();
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

            auto* ctx = acquire_context();
            const auto t0 = std::chrono::steady_clock::now();

            int ret = inference_yolo_rknn(
                ctx, src_bgr,
                m_classes, m_threshold_nms, m_confidence_threshold,
                result, m_logger);

            const auto t1 = std::chrono::steady_clock::now();
            release_context(ctx);

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