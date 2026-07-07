#pragma once

#include "neural/postprocess.h"
#include <cstring>
#include <stdexcept>

namespace varan {
    namespace neural {

        /*
            RAII-обёртка над rknn_app_context_t.

            Владеет input_attrs / output_attrs (malloc/free) и rknn_ctx (rknn_destroy).

            Два режима:
              - master: полноценный контекст, созданный через init_yolov8_model.
                        При разрушении вызывает release_yolov8_model.
              - duplicate: контекст, созданный через rknn_dup_context.
                        При разрушении освобождает attrs вручную + rknn_destroy.

            Move-only (копирование запрещено).
        */
        class RknnContextGuard {
        public:
            // Пустой (невалидный) контекст.
            RknnContextGuard() = default;

            // Создать master-контекст из модели.
            static RknnContextGuard create_master(const std::string& model_path) {
                RknnContextGuard guard;
                guard.m_is_master = true;

                std::memset(&guard.m_ctx, 0, sizeof(rknn_app_context_t));
                int ret = init_yolov8_model(model_path, &guard.m_ctx);
                if (ret != 0) {
                    throw std::runtime_error("init_yolov8_model failed: ret=" +
                        std::to_string(ret) + " path=" + model_path);
                }
                guard.m_valid = true;
                return guard;
            }

            // Создать дубликат из существующего master-контекста.
            static RknnContextGuard create_duplicate(const rknn_app_context_t& master) {
                RknnContextGuard guard;
                guard.m_is_master = false;

                rknn_app_context_t dup{};
                int ret = rknn_dup_context(
                    const_cast<rknn_context*>(&master.rknn_ctx),
                    &dup.rknn_ctx);
                if (ret < 0) {
                    throw std::runtime_error("rknn_dup_context failed: ret=" +
                        std::to_string(ret));
                }

                dup.io_num = master.io_num;
                dup.model_width = master.model_width;
                dup.model_height = master.model_height;
                dup.model_channel = master.model_channel;
                dup.is_quant = master.is_quant;

                const size_t in_sz = master.io_num.n_input * sizeof(rknn_tensor_attr);
                const size_t out_sz = master.io_num.n_output * sizeof(rknn_tensor_attr);

                dup.input_attrs = static_cast<rknn_tensor_attr*>(malloc(in_sz));
                if (!dup.input_attrs) {
                    rknn_destroy(dup.rknn_ctx);
                    throw std::runtime_error("malloc input_attrs failed");
                }

                dup.output_attrs = static_cast<rknn_tensor_attr*>(malloc(out_sz));
                if (!dup.output_attrs) {
                    free(dup.input_attrs);
                    rknn_destroy(dup.rknn_ctx);
                    throw std::runtime_error("malloc output_attrs failed");
                }

                std::memcpy(dup.input_attrs, master.input_attrs, in_sz);
                std::memcpy(dup.output_attrs, master.output_attrs, out_sz);

                guard.m_ctx = dup;
                guard.m_valid = true;
                return guard;
            }

            ~RknnContextGuard() {
                release();
            }

            // Move
            RknnContextGuard(RknnContextGuard&& other) noexcept
                : m_ctx(other.m_ctx)
                , m_is_master(other.m_is_master)
                , m_valid(other.m_valid)
            {
                other.m_valid = false;
                std::memset(&other.m_ctx, 0, sizeof(rknn_app_context_t));
            }

            RknnContextGuard& operator=(RknnContextGuard&& other) noexcept {
                if (this != &other) {
                    release();
                    m_ctx = other.m_ctx;
                    m_is_master = other.m_is_master;
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

                if (m_is_master) {
                    release_yolov8_model(&m_ctx);
                }
                else {
                    if (m_ctx.input_attrs) { free(m_ctx.input_attrs);  m_ctx.input_attrs = nullptr; }
                    if (m_ctx.output_attrs) { free(m_ctx.output_attrs); m_ctx.output_attrs = nullptr; }
                    if (m_ctx.rknn_ctx) { rknn_destroy(m_ctx.rknn_ctx); m_ctx.rknn_ctx = 0; }
                }

                m_valid = false;
                std::memset(&m_ctx, 0, sizeof(rknn_app_context_t));
            }

        private:
            rknn_app_context_t m_ctx{};
            bool m_is_master = false;
            bool m_valid = false;
        };

    } // namespace neural
} // namespace varan