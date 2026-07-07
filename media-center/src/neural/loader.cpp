#include "neural/loader.h"

#include <fstream>
#include <sstream>
#include <set>
#include <map>

namespace varan {
namespace neural {

    UNeuralLoader::UNeuralLoader(
        const std::string& ip_address,
        const std::string& port,
        birdview::UEGLContextManager* context,
        FFrameStorage<IFrame>* storage,
        std::filesystem::path config_path,
        std::filesystem::path state_path,
        ULogger::ELoggerLevel level)
        : m_ip(ip_address), m_port(port)
        , m_context(context), m_storage(storage), m_level(level)
        , m_config_path(std::move(config_path))
        , m_state_path(std::move(state_path))
        , m_logger("NeuralLoader", level)
        , m_json_configurator(&m_logger)
    {
        load_state();
    }

    UNeuralLoader::~UNeuralLoader() { stop_async_run(); }

    // Хелпер для парсинга матрицы камер
    FCameraMatrix UNeuralLoader::parse_camera_matrix(const boost::json::value& v) {
        FCameraMatrix result;
        if (!v.is_array()) return result;
        for (const auto& row_v : v.as_array()) {
            if (!row_v.is_array()) return {};
            std::vector<std::string> row;
            for (const auto& cell : row_v.as_array()) {
                if (!cell.is_string()) return {};
                row.emplace_back(cell.as_string().c_str());
            }
            if (row.empty()) return {};
            result.push_back(std::move(row));
        }
        return result;
    }

    boost::json::array UNeuralLoader::serialize_camera_matrix(const FCameraMatrix& m) {
        boost::json::array result;
        for (const auto& row : m) {
            boost::json::array row_arr;
            for (const auto& c : row) row_arr.emplace_back(c);
            result.push_back(std::move(row_arr));
        }
        return result;
    }

    std::string UNeuralLoader::make_stream_id(const std::string& config_id, const std::string& camera_id) const {
        return "stream_" + config_id + "_" + camera_id;
    }

    // Загрузка текущего состояния с файла
    bool UNeuralLoader::load_state() {
        try {
            if (!std::filesystem::exists(m_state_path)) return false;
            std::ifstream f(m_state_path);
            std::stringstream ss; ss << f.rdbuf();
            auto v = boost::json::parse(ss.str());

            if (!v.is_array()) return false;

            std::vector<FNeuralCoreConfig> parsed;
            for (const auto& entry : v.as_array()) {
                if (!entry.is_object()) continue;
                const auto& eo = entry.as_object();

                FNeuralCoreConfig d;
                // Основные параметры слота
                if (auto* c = eo.if_contains("config_id"); c && c->is_string())
                    d.config_id = c->as_string().c_str();
                if (auto* c = eo.if_contains("camera_matrix"); c)
                    d.cameras = parse_camera_matrix(*c);
                if (auto* c = eo.if_contains("cores"); c && c->is_array()) {
                    for (const auto& ci : c->as_array())
                        if (ci.is_int64()) d.npu_cores.push_back((int)ci.as_int64());
                }

                // Доп параметры
                if (auto* c = eo.if_contains("fps"); c && c->is_int64())
                    d.fps = (int)c->as_int64();
                if (auto* c = eo.if_contains("streaming"); c && c->is_object()) {
                    auto st_o = c->as_object();
                    FStreamingDesc stream_desc;
                    if (auto* s_o = st_o.if_contains("name"); s_o && s_o->is_object())
                        stream_desc.name = s_o->as_string().c_str();
                    if (auto* s_o = st_o.if_contains("id"); s_o && s_o->is_object())
                        stream_desc.id = s_o->as_string().c_str();
                    d.streaming = stream_desc;
                }

                if (!d.config_id.empty() && !d.cameras.empty())
                    parsed.push_back(std::move(d));
            }

            std::lock_guard<std::mutex> lk(m_loader_mutex);
            m_active_descs = std::move(parsed);
            m_logger.info("load_state(): " + std::to_string(m_active_descs.size()) + " slot(s)");
            return true;
        }
        catch (const std::exception& e) {
            m_logger.error("load_state(): " + std::string(e.what()));
            return false;
        }
    }

    bool UNeuralLoader::reload_from_state() { return load_state(); }

    // Запись сохранения состояния в файл
    bool UNeuralLoader::write_state(const std::vector<FNeuralCoreConfig>& active) {
        for (const auto& d : active) {
            if (d.config_id.empty()) {
                m_logger.error("write_state(): empty config_id");
                return false;
            }
            std::string err;
            if (!is_valid_matrix(d.cameras, &err)) {
                m_logger.error("write_state(): " + d.config_id + ": " + err);
                return false;
            }
        }

        {
            std::string err;
            if (!validate_no_core_conflicts(active, err)) {
                m_logger.error("write_state(): " + err);
                return false;
            }
        }

        try {
            boost::json::array arr;
            for (const auto& d : active) {
                boost::json::object entry;
                entry["config_id"] = d.config_id;
                entry["camera_matrix"] = serialize_camera_matrix(d.cameras);
                boost::json::array cores;
                for (int c : d.npu_cores) cores.emplace_back(c);
                entry["cores"] = std::move(cores);
                arr.push_back(std::move(entry));
            }

            std::filesystem::create_directories(m_state_path.parent_path());
            std::ostringstream oss;
            pretty_print(oss, arr);

            std::ofstream f(m_state_path);
            f << oss.str();
        }
        catch (const std::exception& e) {
            m_logger.error("write_state(): " + std::string(e.what()));
            return false;
        }

        {
            std::lock_guard<std::mutex> lk(m_loader_mutex);
            m_active_descs = active;
        }
        m_logger.info("write_state(): " + std::to_string(active.size()) + " entries");
        return true;
    }

    // Обнаружение ошибок ядра (если ядро повторяется в разных контекстах)
    bool UNeuralLoader::validate_no_core_conflicts(
        const std::vector<FNeuralCoreConfig>& descs, std::string& err) const
    {
        std::map<int, std::string> core_owner;
        for (const auto& d : descs) {
            std::vector<int> cores = d.npu_cores;
            if (cores.empty() && descs.size() > 1) {
                err = "'" + d.config_id + "' wants all cores but other slots are active";
                return false;
            }
            if (cores.empty()) cores = { 0, 1, 2 };

            for (int c : cores) {
                if (c < 0 || c > 2) { err = "invalid core index " + std::to_string(c); return false; }
                auto it = core_owner.find(c);
                if (it != core_owner.end()) {
                    err = "core " + std::to_string(c) + " claimed by '" +
                        it->second + "' and '" + d.config_id + "'";
                    return false;
                }
                core_owner[c] = d.config_id;
            }
        }
        return true;
    }

    // вывод список конфигурации
    std::vector<FNeuralExports> UNeuralLoader::list_configurations() const {
        std::vector<FNeuralExports> result;
        try {
            if (!std::filesystem::exists(m_config_path)) return result;
            std::ifstream f(m_config_path);
            std::stringstream ss; ss << f.rdbuf();
            auto v = boost::json::parse(ss.str());
            if (!v.is_object()) return result;

            for (const auto& [id, val] : v.as_object()) {
                if (!val.is_object()) continue;
                FNeuralExports info;
                info.id = id;
                if (auto* n = val.as_object().if_contains("name"); n && n->is_string())
                    info.name = n->as_string().c_str();
                else info.name = info.id;
                result.push_back(std::move(info));
            }
        }
        catch (...) {}
        return result;
    }

    boost::json::value UNeuralLoader::get_configuration_full(const std::string& id) const {
        try {
            if (!std::filesystem::exists(m_config_path)) return boost::json::value(nullptr);
            std::ifstream f(m_config_path);
            std::stringstream ss; ss << f.rdbuf();
            auto v = boost::json::parse(ss.str());
            if (!v.is_object()) return boost::json::value(nullptr);

            auto it = v.as_object().find(id);
            if (it == v.as_object().end()) return boost::json::value(nullptr);
            return it->value();
        }
        catch (...) {
            return boost::json::value(nullptr);
        }
    }

    bool UNeuralLoader::import_configurations(const boost::json::value& json, EImportMode mode) {
        if (!json.is_object()) { m_logger.error("import: not object"); return false; }

        for (const auto& [id, v] : json.as_object()) {
            if (!v.is_object()) { m_logger.error("import: '" + std::string(id) + "' not object"); return false; }
            const auto& obj = v.as_object();
            if (!obj.contains("model_path")) { m_logger.error("import: missing model_path in " + std::string(id)); return false; }
            if (!obj.contains("classes")) { m_logger.error("import: missing classes in " + std::string(id)); return false; }
        }

        try {
            boost::json::object final_obj;
            if (mode == EImportMode::REPLACE_ALL) {
                final_obj = json.as_object();
            }
            else {
                if (std::filesystem::exists(m_config_path)) {
                    std::ifstream f(m_config_path);
                    std::stringstream ss; ss << f.rdbuf();
                    auto existing = boost::json::parse(ss.str());
                    if (existing.is_object()) final_obj = existing.as_object();
                }
                for (const auto& [k, v] : json.as_object()) final_obj[std::string(k)] = v;
            }

            std::filesystem::create_directories(m_config_path.parent_path());
            std::ofstream f(m_config_path);
            f << boost::json::serialize(final_obj);
        }
        catch (const std::exception& e) {
            m_logger.error("import: " + std::string(e.what()));
            return false;
        }
        return true;
    }

    // Запуск всех ядер конфигураий сразу
    bool UNeuralLoader::start_loader() {
        try {
            std::unique_lock<std::mutex> lock(m_loader_mutex);

            if (m_active_descs.empty()) throw std::runtime_error("no active slots");

            if (!m_json_configurator.read(m_config_path))
                throw std::runtime_error("Cannot read " + m_config_path.string());

            // Проверяем конфликты ядер до старта
            std::string err;
            if (!validate_no_core_conflicts(m_active_descs, err)) {
                throw std::runtime_error("core conflict: " + err);
            }

            // Проваерка на уникальность камер внутри слотов
            {
                std::set<std::string> seen_cameras;
                for (const auto& d : m_active_descs) {
                    for (const auto& row : d.cameras) {
                        for (const auto& cam : row) {
                            if (!seen_cameras.insert(cam).second) {
                                throw std::runtime_error("duplicate camera '" + cam + "' across slots");
                            }
                        }
                    }
                }
            }

            // Загружаем конфиги и создаём слоты
            m_slots.clear();
            m_slots.reserve(m_active_descs.size());

            for (size_t i = 0; i < m_active_descs.size(); ++i) {
                // Проверяем флаг остановки, чтобы не создавать лишние слоты при shutdown
                if (!m_supervisor_running.load()) {
                    throw std::runtime_error("shutdown requested during start");
                }

                auto cfg = m_json_configurator.load_config(m_active_descs[i].config_id);
                if (!cfg) throw std::runtime_error("No config: " + m_active_descs[i].config_id);

                if (m_active_descs[i].cameras.empty()) {
                    throw std::runtime_error("No camera in matrix, cannot start " + m_active_descs[i].config_id);
                }

                const std::string& camera_id = m_active_descs[i].cameras[0][0];
                FCameraMessageSender sender;
                if (m_sender_provider) {
                    sender = m_sender_provider(camera_id);
                }

                auto slot = std::make_unique<USlot>(
                    cfg.value(),
                    m_active_descs[i],
                    m_context, 
                    m_storage,
                    std::move(sender),
                    m_level
                );

                if (!slot->start())
                    throw std::runtime_error("Cannot start slot: " + m_active_descs[i].config_id);

                m_slots.push_back(std::move(slot));
            }

            m_logger.info("start_loader(): " + std::to_string(m_slots.size()) + " slot(s)");
            return true;
        }
        catch (const std::exception& e) {
            m_logger.error("start_loader(): " + std::string(e.what()));
            return false;
        }
    }

    void UNeuralLoader::cleanup_after_failure() {
        std::lock_guard<std::mutex> lk(m_loader_mutex);
        for (auto& s : m_slots) if (s) s->stop();
        m_slots.clear();
    }

    // Фкнкции управления
    bool UNeuralLoader::async_run() {
        if (m_supervisor_running.exchange(true)) return false;
        m_supervisor = std::thread(&UNeuralLoader::supervisor_loop, this);
        return true;
    }

    void UNeuralLoader::stop_async_run() {
        if (!m_supervisor_running.exchange(false)) return;
        m_supervisor_cv.notify_all();
        { std::lock_guard<std::mutex> lk(m_loader_mutex); for (auto& s : m_slots) if (s) s->stop(); }
        if (m_supervisor.joinable()) m_supervisor.join();
        cleanup_after_failure();
    }

    bool UNeuralLoader::is_running() const { return m_supervisor_running.load(); }

    void UNeuralLoader::set_sender_provider(FCameraSenderProvider provider) {
        std::lock_guard<std::mutex> lk(m_loader_mutex);
        m_sender_provider = std::move(provider);
    }

    bool UNeuralLoader::restart() {
        if (!m_supervisor_running.load()) return async_run();
        reload_from_state();
        { std::lock_guard<std::mutex> lk(m_loader_mutex); for (auto& s : m_slots) if (s) s->stop(); m_slots.clear(); }
        return true;
    }

    std::optional<std::string> UNeuralLoader::find_camera_config(const std::string& camera_id) const {
        std::lock_guard<std::mutex> lk(m_loader_mutex);
        for (const auto& desc : m_active_descs) {
            for (const auto& row : desc.cameras) {
                for (const auto& cam : row) {
                    if (cam == camera_id)
                        return desc.config_id;
                }
            }
        }
        return std::nullopt;
    }

    std::vector<FNeuralCoreConfig> UNeuralLoader::get_active_descriptors() const {
        std::lock_guard<std::mutex> lk(m_loader_mutex);
        return m_active_descs;
    }

    std::vector<UNeuralLoader::FSlotStatus> UNeuralLoader::get_slots() const {
        std::lock_guard<std::mutex> lk(m_loader_mutex);
        std::vector<FSlotStatus> result;
        for (const auto& s : m_slots) {
            if (!s) continue;
            result.push_back({ s->config_id(), s->cameras(), s->stream_id(), s->is_running(), s->cores() });
        }
        return result;
    }

    // Работчник, который постоянно запускает потоки конфигураций
    void UNeuralLoader::supervisor_loop() {
        using namespace std::chrono;
        int backoff_ms = 1000;
        while (m_supervisor_running) {
            m_logger.info("supervisor: starting...");
            bool started = false;
            try { started = start_loader(); }
            catch (const std::exception& e) { m_logger.error("supervisor: " + std::string(e.what())); }

            if (!started) {
                cleanup_after_failure();
                std::unique_lock<std::mutex> lk(m_supervisor_cv_mutex);
                m_supervisor_cv.wait_for(lk, milliseconds(backoff_ms),
                    [this] { return !m_supervisor_running.load(); });
                if (!m_supervisor_running) break;
                backoff_ms = std::min(backoff_ms * 2, 30000);
                continue;
            }

            backoff_ms = 1000;
            while (m_supervisor_running) {
                std::unique_lock<std::mutex> lk(m_supervisor_cv_mutex);
                m_supervisor_cv.wait_for(lk, seconds(1));
                std::lock_guard<std::mutex> sl(m_loader_mutex);
                bool alive = false;
                for (auto& s : m_slots) if (s && s->is_running()) { alive = true; break; }
                if (!alive) break;
            }

            if (!m_supervisor_running) break;
            m_logger.warn("supervisor: slots died, restarting");
            cleanup_after_failure();
        }
        m_logger.info("supervisor: exiting");
    }

} // namespace neural
} // namespace varan