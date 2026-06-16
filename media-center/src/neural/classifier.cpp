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
            cores = { 0, 1, 2 };  // дефолт — все три
        }
        m_occupied_cores = cores;

        // 1) master контекст
        std::memset(&m_master_ctx, 0, sizeof(rknn_app_context_t));
        int ret = init_yolov8_model(model_path, &m_master_ctx);
        if (ret != 0) {
            if (m_logger) m_logger->error("Classifier: init_yolov8_model fail! ret=" +
                std::to_string(ret) + " path=" + model_path);
            throw std::runtime_error("Classifier: model init failed: " + model_path);
        }

        // 2) Прикрепляем master к первому ядру из списка
        rknn_set_core_mask(m_master_ctx.rknn_ctx, core_index_to_mask(cores[0]));

        m_contexts.reserve(cores.size());
        m_contexts.push_back(m_master_ctx);

        // 3) Дублируем для остальных ядер
        for (size_t i = 1; i < cores.size(); ++i) {
            rknn_app_context_t dup{};
            ret = rknn_dup_context(&m_master_ctx.rknn_ctx, &dup.rknn_ctx);
            if (ret < 0) {
                if (m_logger) m_logger->warn("Classifier: rknn_dup_context #" +
                    std::to_string(i) + " failed, ret=" +
                    std::to_string(ret) + " — skipping core " +
                    std::to_string(cores[i]));
                continue;
            }

            dup.io_num = m_master_ctx.io_num;
            dup.model_width = m_master_ctx.model_width;
            dup.model_height = m_master_ctx.model_height;
            dup.model_channel = m_master_ctx.model_channel;
            dup.is_quant = m_master_ctx.is_quant;

            const size_t in_sz = m_master_ctx.io_num.n_input * sizeof(rknn_tensor_attr);
            const size_t out_sz = m_master_ctx.io_num.n_output * sizeof(rknn_tensor_attr);
            dup.input_attrs = (rknn_tensor_attr*)malloc(in_sz);
            dup.output_attrs = (rknn_tensor_attr*)malloc(out_sz);
            std::memcpy(dup.input_attrs, m_master_ctx.input_attrs, in_sz);
            std::memcpy(dup.output_attrs, m_master_ctx.output_attrs, out_sz);

            rknn_set_core_mask(dup.rknn_ctx, core_index_to_mask(cores[i]));
            m_contexts.push_back(dup);
        }

        for (auto& c : m_contexts) m_pool.push(&c);

        if (m_logger) {
            std::string cores_str;
            for (int c : m_occupied_cores) cores_str += std::to_string(c) + ",";
            if (!cores_str.empty()) cores_str.pop_back();
            m_logger->info("Classifier: loaded " + model_path +
                " (input=" + std::to_string(m_master_ctx.model_width) + "x" +
                std::to_string(m_master_ctx.model_height) +
                ", cores=[" + cores_str + "]" +
                ", workers=" + std::to_string(m_contexts.size()) + ")");
        }
    }

    Classifier::~Classifier() {
        for (size_t i = 0; i < m_contexts.size(); ++i) {
            if (i == 0) {
                release_yolov8_model(&m_contexts[0]);
            }
            else {
                if (m_contexts[i].input_attrs)  free(m_contexts[i].input_attrs);
                if (m_contexts[i].output_attrs) free(m_contexts[i].output_attrs);
                if (m_contexts[i].rknn_ctx)     rknn_destroy(m_contexts[i].rknn_ctx);
            }
        }
    }

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