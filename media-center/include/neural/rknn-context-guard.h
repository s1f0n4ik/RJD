#pragma once

#include "neural/postprocess.h"
#include "neural/yolov8.h"
#include <cstring>
#include <stdexcept>

namespace varan {
    namespace neural {

        /*
            RAII-обёртка над rknn_app_context_t: владеет input_attrs / output_attrs
            (malloc/free) и rknn_ctx (rknn_destroy). Move-only.
        */
        class RknnContextGuard {
        public:
            // Пустой (невалидный) контекст.
            RknnContextGuard() = default;

            // Создать контекст из модели.
            static RknnContextGuard create_master(const std::string& model_path) {
                RknnContextGuard guard;

                std::memset(&guard.m_ctx, 0, sizeof(rknn_app_context_t));
                int ret = init_yolov8_model(model_path, &guard.m_ctx);
                if (ret != 0) {
                    throw std::runtime_error("init_yolov8_model failed: ret=" +
                        std::to_string(ret) + " path=" + model_path);
                }
                guard.m_valid = true;
                return guard;
            }

            ~RknnContextGuard() {
                release();
            }

            // Move
            RknnContextGuard(RknnContextGuard&& other) noexcept
                : m_ctx(other.m_ctx)
                , m_valid(other.m_valid)
            {
                other.m_valid = false;
                std::memset(&other.m_ctx, 0, sizeof(rknn_app_context_t));
            }

            RknnContextGuard& operator=(RknnContextGuard&& other) noexcept {
                if (this != &other) {
                    release();
                    m_ctx = other.m_ctx;
                    m_valid = other.m_valid;
                    other.m_valid = false;
                    std::memset(&other.m_ctx, 0, sizeof(rknn_app_context_t));
                }
                return *this;
            }

            // No copy
            RknnContextGuard(const RknnContextGuard&) = delete;
            RknnContextGuard& operator=(const RknnContextGuard&) = delete;

            // Доступ к «сырому» контексту (для передачи в inference и pool).
            rknn_app_context_t* get() { return m_valid ? &m_ctx : nullptr; }
            const rknn_app_context_t* get() const { return m_valid ? &m_ctx : nullptr; }

            bool valid() const { return m_valid; }

            // Установить core mask (обёртка для удобства).
            void set_core_mask(rknn_core_mask mask) {
                if (m_valid) {
                    rknn_set_core_mask(m_ctx.rknn_ctx, mask);
                }
            }

        private:
            void release() {
                if (!m_valid) return;
                release_yolov8_model(&m_ctx);
                m_valid = false;
                std::memset(&m_ctx, 0, sizeof(rknn_app_context_t));
            }

        private:
            rknn_app_context_t m_ctx{};
            bool m_valid = false;
        };

    } // namespace neural
} // namespace varan
