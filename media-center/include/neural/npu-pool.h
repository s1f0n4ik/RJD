#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "neural/rknn-context-guard.h"
#include "logger.h"

namespace varan {
namespace neural {

    struct FTensorInfo {
        std::string name;
        std::vector<uint32_t> dims;
        std::string type;
        std::string format;
        float scale = 1.f;
        int zp = 0;
    };

    // Всё, что rknn рассказал о модели при загрузке; читается один раз на группу
    struct FModelInfo {
        std::string path;
        std::string layout;
        int class_count = 0;
        int input_width = 0;
        int input_height = 0;
        int input_channels = 0;
        bool quantized = false;
        std::vector<FTensorInfo> inputs;
        std::vector<FTensorInfo> outputs;
        std::string api_version;
        std::string driver_version;
        uint32_t weight_bytes = 0;
        uint32_t internal_bytes = 0;
    };

    // Общий пул контекстов NPU на процесс. Контексты группируются по файлу модели,
    // каждый поднимается своим rknn_init. Ядро не назначается — RKNN по умолчанию
    // кладёт каждый прогон на самое свободное; VARAN_NPU_CORE_MODE=pinned включает
    // круговой обход по ядрам.
    class UNpuPool {
    public:
        struct FGroup;

        // Ручка слота на группу модели: столько контекстов, сколько попросили глубиной
        class UHandle {
        public:
            ~UHandle();
            UHandle(const UHandle&) = delete;
            UHandle& operator=(const UHandle&) = delete;

            // Ждёт свободный контекст группы
            rknn_app_context_t* acquire();
            // broken — контекст выбрасывается из группы
            void release(rknn_app_context_t* ctx, bool broken = false);

            const rknn_app_context_t& master() const;
            const FModelInfo& info() const;
            int depth_actual() const;

        private:
            friend class UNpuPool;
            UHandle(std::shared_ptr<FGroup> group, int depth) : m_group(std::move(group)), m_depth(depth) {}
            std::shared_ptr<FGroup> m_group;
            int m_depth;
        };

        static UNpuPool& instance();

        // Бросает FNeuralError: 6002 файла нет, 6003 rknn_init, 6004 раскладка не опознана
        std::unique_ptr<UHandle> attach(const std::string& model_path, int depth, ULogger* logger);

        int core_count() const { return m_npu_cores; }
        bool pinned() const { return m_pinned; }
        int context_count() const;

    private:
        UNpuPool();
        void set_core(RknnContextGuard& guard);
        static FModelInfo read_model_info(const rknn_app_context_t& ctx, const std::string& path);

        mutable std::mutex m_mutex;
        std::map<std::string, std::weak_ptr<FGroup>> m_groups;
        int m_npu_cores = 0;
        bool m_pinned = false;
        int m_next_core = 0;
    };

} // namespace neural
} // namespace varan
