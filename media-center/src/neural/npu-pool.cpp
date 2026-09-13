#include "neural/npu-pool.h"
#include "neural/utility.h"
#include "core/platform.h"
#include "signaling_definers.h"

#include <algorithm>
#include <cstdlib>
#include <filesystem>

namespace varan {
namespace neural {

    struct UNpuPool::FGroup {
        std::string model_path;
        FModelInfo info;
        // contexts[0] — первый загруженный, по нему читается FModelInfo. deque: free
        // хранит адреса элементов, а push_back не должен их сдвигать
        std::deque<RknnContextGuard> contexts;
        std::deque<rknn_app_context_t*> free;
        std::mutex mutex;
        std::condition_variable cv;
        int users = 0;

        int depth_actual() {
            std::lock_guard<std::mutex> lk(mutex);
            return static_cast<int>(std::count_if(contexts.begin(), contexts.end(),
                [](const RknnContextGuard& g) { return g.valid(); }));
        }
    };

    UNpuPool& UNpuPool::instance() {
        static UNpuPool pool;
        return pool;
    }

    UNpuPool::UNpuPool() {
        m_npu_cores = detect_platform().npu_cores;
        const char* mode = std::getenv("VARAN_NPU_CORE_MODE");
        m_pinned = mode && std::string(mode) == "pinned" && m_npu_cores > 0;
    }

    void UNpuPool::set_core(RknnContextGuard& guard) {
        if (!m_pinned) return;
        static const rknn_core_mask masks[] = { RKNN_NPU_CORE_0, RKNN_NPU_CORE_1, RKNN_NPU_CORE_2 };
        guard.set_core_mask(masks[m_next_core++ % std::min(m_npu_cores, 3)]);
    }

    std::unique_ptr<UNpuPool::UHandle> UNpuPool::attach(const std::string& model_path, int depth, ULogger* logger) {
        using namespace varan::signaling;
        std::lock_guard<std::mutex> lk(m_mutex);

        std::shared_ptr<FGroup> group = m_groups[model_path].lock();
        if (!group) {
            if (!std::filesystem::exists(model_path))
                throw FNeuralError(CODE_NEURAL_NO_MODEL, "model file not found: " + model_path);

            group = std::make_shared<FGroup>();
            group->model_path = model_path;
            try {
                group->contexts.push_back(RknnContextGuard::create_master(model_path));
            }
            catch (const std::exception& e) {
                throw FNeuralError(CODE_NEURAL_INIT, e.what());
            }
            if (group->contexts[0].get()->layout == EOutputLayout::UNKNOWN)
                throw FNeuralError(CODE_NEURAL_LAYOUT, "output layout not recognised: " + model_path);
            set_core(group->contexts[0]);
            group->free.push_back(group->contexts[0].get());
            group->info = read_model_info(*group->contexts[0].get(), model_path);
            m_groups[model_path] = group;
            if (logger) logger->info("NpuPool: loaded " + model_path +
                " (" + group->info.layout +
                ", classes=" + std::to_string(group->info.class_count) +
                ", input=" + std::to_string(group->info.input_width) + "x" + std::to_string(group->info.input_height) +
                ", " + (group->info.quantized ? "int8" : "float") +
                ", weights=" + std::to_string(group->info.weight_bytes / 1024) + "K" +
                ", api=" + group->info.api_version + ", drv=" + group->info.driver_version + ")");
        }

        // Первый пользователь уже получил master, остальным нужны все depth контекстов
        const int extra = group->users == 0 ? depth - 1 : depth;
        {
            std::lock_guard<std::mutex> gl(group->mutex);
            // Каждый контекст через свой rknn_init. rknn_dup_context не годится:
            // на librknnrt 2.3.0 параллельные прогоны дубликатов портят выходы
            // (проверено 13.09.2026: 7500 детекций на пустом кадре при любой маске ядер)
            // ponytail: веса дублируются на каждый контекст; RKNN_FLAG_SHARE_WEIGHT_MEM, если память NPU станет тесной
            for (int i = 0; i < extra; ++i) {
                try {
                    group->contexts.push_back(RknnContextGuard::create_master(model_path));
                }
                catch (const std::exception& e) {
                    if (logger) logger->warn("NpuPool: context #" + std::to_string(i + 1) + " failed for " + model_path + ": " + e.what());
                    break;
                }
                set_core(group->contexts.back());
                group->free.push_back(group->contexts.back().get());
            }
            group->users++;
        }
        group->cv.notify_all();

        // ponytail: контексты ушедшего слота остаются в группе до её полного освобождения; удалять по одному, если память NPU станет тесной
        return std::unique_ptr<UHandle>(new UHandle(group, depth));
    }

    FModelInfo UNpuPool::read_model_info(const rknn_app_context_t& ctx, const std::string& path) {
        FModelInfo info;
        info.path = path;
        info.layout = output_layout_name(ctx.layout);
        info.class_count = ctx.model_class_count;
        info.input_width = ctx.model_width;
        info.input_height = ctx.model_height;
        info.input_channels = ctx.model_channel;
        info.quantized = ctx.is_quant;

        auto tensor = [](const rknn_tensor_attr& a) {
            FTensorInfo t;
            t.name = a.name;
            t.dims.assign(a.dims, a.dims + a.n_dims);
            t.type = get_type_string(a.type);
            t.format = get_format_string(a.fmt);
            t.scale = a.scale;
            t.zp = a.zp;
            return t;
        };
        for (uint32_t i = 0; i < ctx.io_num.n_input; ++i) info.inputs.push_back(tensor(ctx.input_attrs[i]));
        for (uint32_t i = 0; i < ctx.io_num.n_output; ++i) info.outputs.push_back(tensor(ctx.output_attrs[i]));

        rknn_sdk_version version{};
        if (rknn_query(ctx.rknn_ctx, RKNN_QUERY_SDK_VERSION, &version, sizeof(version)) == RKNN_SUCC) {
            info.api_version = version.api_version;
            info.driver_version = version.drv_version;
        }
        rknn_mem_size mem{};
        if (rknn_query(ctx.rknn_ctx, RKNN_QUERY_MEM_SIZE, &mem, sizeof(mem)) == RKNN_SUCC) {
            info.weight_bytes = mem.total_weight_size;
            info.internal_bytes = mem.total_internal_size;
        }
        return info;
    }

    int UNpuPool::context_count() const {
        int total = 0;
        std::lock_guard<std::mutex> lk(m_mutex);
        for (const auto& [path, weak] : m_groups)
            if (auto g = weak.lock()) total += g->depth_actual();
        return total;
    }

    UNpuPool::UHandle::~UHandle() {
        std::lock_guard<std::mutex> lk(m_group->mutex);
        m_group->users--;
    }

    rknn_app_context_t* UNpuPool::UHandle::acquire() {
        std::unique_lock<std::mutex> lk(m_group->mutex);
        m_group->cv.wait(lk, [this] { return !m_group->free.empty(); });
        auto* ctx = m_group->free.front();
        m_group->free.pop_front();
        return ctx;
    }

    void UNpuPool::UHandle::release(rknn_app_context_t* ctx, bool broken) {
        {
            std::lock_guard<std::mutex> lk(m_group->mutex);
            if (broken) {
                auto it = std::find_if(m_group->contexts.begin(), m_group->contexts.end(),
                    [ctx](const RknnContextGuard& g) { return g.get() == ctx; });
                // Первый контекст не выбрасываем: master() и info() читаются по нему
                if (it != m_group->contexts.end() && it != m_group->contexts.begin()) {
                    *it = RknnContextGuard();
                    m_group->cv.notify_all();
                    return;
                }
            }
            m_group->free.push_back(ctx);
        }
        m_group->cv.notify_one();
    }

    const rknn_app_context_t& UNpuPool::UHandle::master() const {
        return *m_group->contexts[0].get();
    }

    const FModelInfo& UNpuPool::UHandle::info() const {
        return m_group->info;
    }

    int UNpuPool::UHandle::depth_actual() const {
        return std::min(m_depth, m_group->depth_actual());
    }

} // namespace neural
} // namespace varan
