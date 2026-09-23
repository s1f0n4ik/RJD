#include "neural/loader.h"
#include "core/paths.h"
#include "core/time-sync.h"
#include "neural/npu-pool.h"
#include "signaling_definers.h"

#include <algorithm>
#include <fstream>
#include <sstream>
#include <set>
#include <map>
#include <cstdlib>

namespace varan {
namespace neural {

    UNeuralLoader::UNeuralLoader(
        const std::string& ip_address,
        const std::string& port,
        birdview::UEGLContextManager* context,
        FFrameStorage<IFrame>* storage,
        std::filesystem::path config_path,
        std::filesystem::path state_path,
        FPlatformInfo platform,
        std::shared_ptr<gateway::UGatewayClient> gateway,
        ULogger::ELoggerLevel level)
        : m_ip(ip_address), m_port(port)
        , m_context(context), m_storage(storage), m_level(level)
        , m_config_path(std::move(config_path))
        , m_streams_path(varan::paths().neural.streams)
        , m_state_path(std::move(state_path))
        , m_platform(std::move(platform))
        , m_gateway(std::move(gateway))
        , m_logger("NeuralLoader", level)
        , m_json_configurator(&m_logger)
    {
        if (m_gateway) {
            m_logger.info("gateway ingress: using shared client");
        }

        // Журнал обнаружений: SQLite + JPEG на томе /storage. Общий writer для
        // всех слотов; при ошибке БД остаётся nullptr, слоты пишут без журнала.
        // Каталог задаётся флагом --journal-dir и разбирается в main.
        {
            const std::filesystem::path journal_dir = varan::paths().journal;

            auto writer = std::make_unique<journal::UJournalWriter>(
                journal_dir / "journal.db", journal_dir / "frames", level);
            if (writer->start()) {
                m_journal = std::move(writer);
                m_logger.info("journal enabled -> " + journal_dir.string());
            } else {
                // Журнал не поднялся — это не повод ронять нейронку, но знать об
                // этом надо: без него обнаружения никуда не запишутся.
                m_logger.error("journal DISABLED: writer start failed at "
                    + journal_dir.string() + " (check permissions and sqlite availability)");
            }
        }

        load_state();
    }

    UNeuralLoader::~UNeuralLoader() { stop_async_run(); }

    gateway::FGatewayTimeGps UNeuralLoader::current_synced_time() const {
        if (!time_sync::synced()) {
            return {};
        }
        return time_sync::now();
    }

    std::string UNeuralLoader::make_output_id(const std::string& config_id, const std::string& stream_id) const {
        return "stream_" + config_id + "_" + stream_id;
    }

    // Первая камера из старых полей дескриптора: camera_layout (single / tiles / regions) или camera_matrix
    static std::string legacy_first_camera(const boost::json::object& eo) {
        if (auto* cl = eo.if_contains("camera_layout"); cl && cl->is_object()) {
            const auto& o = cl->as_object();
            if (auto* s = o.if_contains("single"); s && s->is_string() && !s->as_string().empty())
                return s->as_string().c_str();
            for (const char* key : { "tiles", "regions" }) {
                auto* arr = o.if_contains(key);
                if (!arr || !arr->is_array()) continue;
                for (const auto& t : arr->as_array()) {
                    if (!t.is_object()) continue;
                    if (auto* c = t.as_object().if_contains("camera"); c && c->is_string() && !c->as_string().empty())
                        return c->as_string().c_str();
                }
            }
        }
        if (auto* cm = eo.if_contains("camera_matrix"); cm && cm->is_array()) {
            for (const auto& row : cm->as_array()) {
                if (!row.is_array()) continue;
                for (const auto& c : row.as_array())
                    if (c.is_string() && !c.as_string().empty()) return c.as_string().c_str();
            }
        }
        return {};
    }

    std::map<std::string, FVideoStream> UNeuralLoader::read_streams() const {
        std::map<std::string, FVideoStream> out;
        try {
            if (!std::filesystem::exists(m_streams_path)) return out;
            std::ifstream f(m_streams_path);
            std::stringstream ss; ss << f.rdbuf();
            auto v = boost::json::parse(ss.str());
            if (!v.is_object()) return out;
            for (const auto& [id, val] : v.as_object())
                out[std::string(id)] = parse_stream(val, std::string(id));
        }
        catch (const std::exception& e) {
            m_logger.error("read_streams(): " + std::string(e.what()));
        }
        return out;
    }

    bool UNeuralLoader::write_streams(const std::map<std::string, FVideoStream>& streams) {
        try {
            boost::json::object obj;
            for (const auto& [id, s] : streams) obj[id] = serialize_stream(s);
            std::filesystem::create_directories(m_streams_path.parent_path());
            std::ostringstream oss;
            pretty_print(oss, obj);
            std::ofstream f(m_streams_path);
            f << oss.str();
            return true;
        }
        catch (const std::exception& e) {
            m_logger.error("write_streams(): " + std::string(e.what()));
            return false;
        }
    }

    std::string UNeuralLoader::ensure_camera_stream(const std::string& config_id, const std::string& camera) {
        const std::string id = config_id + "_" + camera;
        std::lock_guard<std::mutex> lk(m_streams_mutex);
        auto streams = read_streams();
        if (streams.count(id)) return id;
        int width = 640, height = 640;
        probe_model_size(config_id, width, height);
        streams[id] = stream_from_camera(id, config_id, camera, width, height);
        write_streams(streams);
        m_logger.info("ensure_camera_stream(): created stream '" + id + "' for " + config_id + " on " + camera);
        return id;
    }

    std::vector<FVideoStream> UNeuralLoader::list_streams() const {
        std::lock_guard<std::mutex> lk(m_streams_mutex);
        std::vector<FVideoStream> out;
        for (auto& [id, s] : read_streams()) out.push_back(std::move(s));
        return out;
    }

    std::optional<FVideoStream> UNeuralLoader::get_stream(const std::string& id) const {
        std::lock_guard<std::mutex> lk(m_streams_mutex);
        auto streams = read_streams();
        auto it = streams.find(id);
        if (it == streams.end()) return std::nullopt;
        return it->second;
    }

    bool UNeuralLoader::save_stream(const FVideoStream& stream, std::string* err) {
        if (!is_valid_stream(stream, err)) return false;
        {
            std::lock_guard<std::mutex> lk(m_streams_mutex);
            auto streams = read_streams();
            streams[stream.id] = stream;
            if (!write_streams(streams)) {
                if (err) *err = "cannot write " + m_streams_path.string();
                return false;
            }
        }
        // Слот на этом потоке пересобирается с новой раскладкой
        bool used = false;
        {
            std::lock_guard<std::mutex> lk(m_loader_mutex);
            for (auto& d : m_active_descs)
                if (d.stream_id == stream.id) { d.config_id = stream.config_id; used = true; }
        }
        if (used && m_supervisor_running.load()) restart();
        m_logger.info("save_stream(): '" + stream.id + "' saved" + (used ? ", slot restart requested" : ""));
        return true;
    }

    UNeuralLoader::EDeleteResult UNeuralLoader::delete_stream(const std::string& id) {
        {
            std::lock_guard<std::mutex> lk(m_loader_mutex);
            for (const auto& d : m_active_descs)
                if (d.stream_id == id) return EDeleteResult::IN_USE;
        }
        std::lock_guard<std::mutex> lk(m_streams_mutex);
        auto streams = read_streams();
        if (!streams.erase(id)) return EDeleteResult::NOT_FOUND;
        if (!write_streams(streams)) return EDeleteResult::FAILED;
        m_logger.info("delete_stream(): '" + id + "' removed");
        return EDeleteResult::OK;
    }

    bool UNeuralLoader::probe_model_size(const std::string& config_id, int& width, int& height) const {
        UJsonNeuralConfiguration configurator;
        if (!configurator.read(m_config_path)) return false;
        auto cfg = configurator.load_config(config_id);
        if (!cfg) return false;
        try {
            // Модель уже загруженного слота берётся из общей группы пула без нового rknn_init
            auto handle = UNpuPool::instance().attach(cfg->model_path, 1, nullptr);
            const auto& info = handle->info();
            if (info.input_width <= 0 || info.input_height <= 0) return false;
            width = info.input_width;
            height = info.input_height;
            return true;
        }
        catch (const std::exception& e) {
            m_logger.warn("probe_model_size(): " + config_id + ": " + e.what());
            return false;
        }
    }

    // Загрузка текущего состояния с файла
    bool UNeuralLoader::load_state() {
        try {
            if (!std::filesystem::exists(m_state_path)) return false;
            std::ifstream f(m_state_path);
            std::stringstream ss; ss << f.rdbuf();
            auto v = boost::json::parse(ss.str());

            if (!v.is_array()) return false;

            const auto streams = [this] {
                std::lock_guard<std::mutex> lk(m_streams_mutex);
                return read_streams();
            }();
            bool migrated = false;

            std::vector<FNeuralCoreConfig> parsed;
            for (const auto& entry : v.as_array()) {
                if (!entry.is_object()) continue;
                const auto& eo = entry.as_object();

                FNeuralCoreConfig d;
                if (auto* c = eo.if_contains("stream_id"); c && c->is_string())
                    d.stream_id = c->as_string().c_str();
                if (auto* c = eo.if_contains("config_id"); c && c->is_string())
                    d.config_id = c->as_string().c_str();

                // Старое состояние: конфигурация + камера → поток «камера как есть»
                if (d.stream_id.empty() && !d.config_id.empty()) {
                    const std::string camera = legacy_first_camera(eo);
                    if (camera.empty()) continue;
                    d.stream_id = ensure_camera_stream(d.config_id, camera);
                    migrated = true;
                }
                else if (auto it = streams.find(d.stream_id); it != streams.end())
                    d.config_id = it->second.config_id;
                else
                    m_logger.warn("load_state(): stream '" + d.stream_id + "' not found, slot will fail with 6008");

                // Старое поле cores игнорируется: ядра раздаёт драйвер
                if (auto* c = eo.if_contains("depth"); c && c->is_int64())
                    d.depth = std::max(1, (int)c->as_int64());

                // Доп параметры
                if (auto* c = eo.if_contains("fps"); c && c->is_int64())
                    d.fps = (int)c->as_int64();
                if (auto* c = eo.if_contains("streaming"); c && c->is_object()) {
                    const auto& st_o = c->as_object();
                    bool enabled = true;
                    if (auto* e = st_o.if_contains("enabled"); e && e->is_bool()) enabled = e->as_bool();
                    if (enabled) {
                        FStreamingDesc stream_desc;
                        if (auto* s = st_o.if_contains("name"); s && s->is_string())
                            stream_desc.name = s->as_string().c_str();
                        if (auto* s = st_o.if_contains("id"); s && s->is_string())
                            stream_desc.id = s->as_string().c_str();
                        d.streaming = std::move(stream_desc);
                    }
                }
                if (auto* c = eo.if_contains("event_mask"); c && c->is_array()) {
                    for (const auto& ev : c->as_array())
                        if (ev.is_string()) d.event_mask.emplace_back(ev.as_string().c_str());
                }

                if (!d.stream_id.empty())
                    parsed.push_back(std::move(d));
            }

            {
                std::lock_guard<std::mutex> lk(m_loader_mutex);
                m_active_descs = parsed;
                m_logger.info("load_state(): " + std::to_string(m_active_descs.size()) + " slot(s)");
            }
            if (migrated) {
                m_logger.info("load_state(): legacy state migrated to stream_id, rewriting " + m_state_path.string());
                write_state(parsed);
            }
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
        const auto streams = [this] {
            std::lock_guard<std::mutex> lk(m_streams_mutex);
            return read_streams();
        }();
        std::vector<FNeuralCoreConfig> resolved = active;
        for (auto& d : resolved) {
            if (d.stream_id.empty()) {
                m_logger.error("write_state(): empty stream_id");
                return false;
            }
            auto it = streams.find(d.stream_id);
            if (it == streams.end()) {
                m_logger.error("write_state(): stream '" + d.stream_id + "' not found");
                return false;
            }
            d.config_id = it->second.config_id;
            if (d.config_id.empty()) {
                m_logger.error("write_state(): stream '" + d.stream_id + "' has no configuration");
                return false;
            }
        }

        // Видеопоток несёт и камеры, и конфигурацию: дважды один поток — дубль слота
        for (size_t i = 0; i < resolved.size(); ++i)
            for (size_t j = i + 1; j < resolved.size(); ++j)
                if (resolved[i].stream_id == resolved[j].stream_id) {
                    m_logger.error("write_state(): duplicate slot on stream '" + resolved[i].stream_id + "'");
                    return false;
                }

        try {
            boost::json::array arr;
            for (const auto& d : resolved) {
                boost::json::object entry;
                entry["stream_id"] = d.stream_id;
                entry["depth"] = d.depth;
                entry["fps"] = d.fps;
                if (d.streaming) {
                    boost::json::object st;
                    st["enabled"] = true;
                    st["name"] = d.streaming->name;
                    if (!d.streaming->id.empty()) st["id"] = d.streaming->id;
                    entry["streaming"] = std::move(st);
                }
                if (!d.event_mask.empty()) {
                    boost::json::array em;
                    for (const auto& e : d.event_mask) em.emplace_back(e);
                    entry["event_mask"] = std::move(em);
                }
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
            m_active_descs = resolved;
        }
        m_logger.info("write_state(): " + std::to_string(resolved.size()) + " entries");
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

    UNeuralLoader::EDeleteResult UNeuralLoader::delete_configuration(const std::string& id) {
        {
            // Конфигурация занята, пока её видеопоток стоит в слоте
            std::lock_guard<std::mutex> lk(m_loader_mutex);
            for (const auto& d : m_active_descs)
                if (d.config_id == id) return EDeleteResult::IN_USE;
        }
        try {
            if (!std::filesystem::exists(m_config_path)) return EDeleteResult::NOT_FOUND;
            std::ifstream f(m_config_path);
            std::stringstream ss; ss << f.rdbuf();
            auto v = boost::json::parse(ss.str());
            if (!v.is_object()) return EDeleteResult::NOT_FOUND;
            auto& obj = v.as_object();
            if (!obj.contains(id)) return EDeleteResult::NOT_FOUND;
            obj.erase(id);

            std::ofstream out(m_config_path);
            out << boost::json::serialize(obj);
            m_logger.info("delete_configuration(): '" + id + "' removed");
            return EDeleteResult::OK;
        }
        catch (const std::exception& e) {
            m_logger.error("delete_configuration(): " + std::string(e.what()));
            return EDeleteResult::FAILED;
        }
    }

    // Запуск всех ядер конфигураий сразу
    bool UNeuralLoader::start_loader() {
        // Прошлые слоты гасятся до захвата m_loader_mutex
        cleanup_after_failure();

        try {
            std::unique_lock<std::mutex> lock(m_loader_mutex);

            if (m_active_descs.empty()) throw std::runtime_error("no active slots");

            if (!m_json_configurator.read(m_config_path))
                throw std::runtime_error("Cannot read " + m_config_path.string());

            // Слот, который не поднялся, остаётся на своём месте с причиной; остальные работают
            m_slots.clear();
            m_failed.clear();
            m_slots.resize(m_active_descs.size());
            int started = 0;

            for (size_t i = 0; i < m_active_descs.size(); ++i) {
                // Проверяем флаг остановки, чтобы не создавать лишние слоты при shutdown
                if (!m_supervisor_running.load()) {
                    throw std::runtime_error("shutdown requested during start");
                }
                try {
                    m_slots[i] = make_slot(m_active_descs[i]);
                    if (m_slots[i]->start()) ++started;
                }
                catch (const FNeuralError& e) {
                    m_logger.error("slot " + m_active_descs[i].config_id + ": [" + std::to_string(e.code) + "] " + e.what());
                    m_failed[i] = { e.code, e.what() };
                }
            }

            m_logger.info("start_loader(): " + std::to_string(started) + " of " +
                std::to_string(m_active_descs.size()) + " slot(s) started");
            return true;
        }
        catch (const std::exception& e) {
            m_logger.error("start_loader(): " + std::string(e.what()));
            return false;
        }
    }

    std::unique_ptr<USlot> UNeuralLoader::make_slot(FNeuralCoreConfig desc) {
        auto video = get_stream(desc.stream_id);
        if (!video) throw FNeuralError(signaling::CODE_NEURAL_NO_STREAM, "no stream: " + desc.stream_id);
        desc.config_id = video->config_id;
        if (desc.config_id.empty())
            throw FNeuralError(signaling::CODE_NEURAL_NO_CONFIG, "stream has no configuration: " + desc.stream_id);
        auto cfg = m_json_configurator.load_config(desc.config_id);
        if (!cfg) throw FNeuralError(signaling::CODE_NEURAL_NO_CONFIG, "no configuration: " + desc.config_id);

        // Пер-стримовая маска событий переопределяет маску трекера конфигурации.
        if (cfg->tracker_config && !desc.event_mask.empty()) {
            cfg->tracker_config->event_mask = event_mask_from_types(desc.event_mask);
        }

        if (stream_cameras(*video).empty()) {
            throw FNeuralError(signaling::CODE_NEURAL_CAMERA, "no cameras in stream: " + desc.stream_id);
        }

        // Стриминг: подставляем адрес сигналинг-сервера и генерируем
        // id вывода, если они не заданы явно в дескрипторе.
        if (desc.streaming) {
            auto& st = *desc.streaming;
            if (st.ip.empty())   st.ip = m_ip;
            if (st.port.empty()) st.port = m_port;
            if (st.id.empty())   st.id = make_output_id(desc.config_id, desc.stream_id);
        }

        // Отправка в message-gateway идёт через общий клиент загрузчика;
        // id камеры проставляет сам слот в теле сообщения.
        gateway::FGatewayFrameSender gateway_sender;
        gateway::FGatewayTimeProvider time_provider;
        if (m_gateway) {
            auto gw = m_gateway;
            gateway_sender = [gw](gateway::FGatewayFrame frame) { gw->send(std::move(frame)); };
            time_provider = [this]() { return current_synced_time(); };
        }

        m_logger.info("slot " + desc.config_id + ": journal=" + (m_journal ? "on" : "off"));

        return std::make_unique<USlot>(
            cfg.value(),
            desc,
            *video,
            m_context,
            m_storage,
            m_sender_provider,
            std::move(gateway_sender),
            std::move(time_provider),
            m_journal ? m_journal->slot_journal() : journal::FSlotJournal{},
            m_level
        );
    }

    void UNeuralLoader::restart_slot(size_t index) {
        m_logger.warn("slot " + m_active_descs[index].config_id + " died, restarting");
        if (m_slots[index]) m_slots[index]->stop();
        m_slots[index].reset();
        try {
            m_slots[index] = make_slot(m_active_descs[index]);
            m_slots[index]->start();
        }
        catch (const FNeuralError& e) {
            m_logger.error("slot " + m_active_descs[index].config_id + ": [" + std::to_string(e.code) + "] " + e.what());
            m_failed[index] = { e.code, e.what() };
        }
    }

    void UNeuralLoader::cleanup_after_failure() {
        // Слоты гасятся и разрушаются без m_loader_mutex
        std::vector<std::unique_ptr<USlot>> slots;
        {
            std::lock_guard<std::mutex> lk(m_loader_mutex);
            slots.swap(m_slots);
        }
        for (auto& s : slots) if (s) s->stop();
        slots.clear();
    }

    // Фкнкции управления
    bool UNeuralLoader::async_run() {
        if (m_supervisor_running.exchange(true)) return false;
        // Клиент шлюза общий на процесс — его жизненным циклом владеет main
        m_supervisor = std::thread(&UNeuralLoader::supervisor_loop, this);
        return true;
    }

    void UNeuralLoader::stop_async_run() {
        if (!m_supervisor_running.exchange(false)) return;
        m_supervisor_cv.notify_all();
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
        m_reload.store(true);
        m_supervisor_cv.notify_all();
        return true;
    }

    std::optional<std::string> UNeuralLoader::find_camera_config(const std::string& camera_id) const {
        const auto streams = [this] {
            std::lock_guard<std::mutex> lk(m_streams_mutex);
            return read_streams();
        }();
        std::lock_guard<std::mutex> lk(m_loader_mutex);
        for (const auto& desc : m_active_descs) {
            auto it = streams.find(desc.stream_id);
            if (it == streams.end()) continue;
            for (const auto& cam : stream_cameras(it->second))
                if (cam == camera_id) return desc.config_id;
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
        for (size_t i = 0; i < m_slots.size(); ++i) {
            const auto& s = m_slots[i];
            FSlotStatus status;
            if (!s) {
                // Слот не создан: строка из дескриптора и причина из m_failed
                const auto& d = m_active_descs[i];
                status.stream_id = d.stream_id;
                status.config_id = d.config_id;
                status.depth = d.depth;
                status.fps_limit = d.fps;
                if (auto it = m_failed.find(i); it != m_failed.end()) {
                    status.code = it->second.first;
                    status.error = it->second.second;
                }
                result.push_back(std::move(status));
                continue;
            }
            status.stream_id = s->video_id();
            status.config_id = s->config_id();
            status.video = s->video();
            status.tiles = s->tiles();
            status.canvas_width = s->canvas_width();
            status.canvas_height = s->canvas_height();
            status.output_id = s->stream_id();
            status.output_name = s->stream_name();
            status.stream_width = s->stream_width();
            status.stream_height = s->stream_height();
            status.running = s->is_running();
            status.depth = s->depth();
            status.depth_actual = s->depth_actual();
            status.fps_limit = s->fps_limit();
            status.layout = s->model_layout();
            if (const auto* info = s->model_info()) status.model = *info;
            status.code = s->error_code();
            status.error = s->error();
            status.infer_ms = s->infer_ms();
            status.wait_ms = s->wait_ms();
            status.fps = s->fps();
            status.detections = s->detections();
            status.tracks = s->tracks();
            status.dropped = s->dropped();
            result.push_back(std::move(status));
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
            m_reload.store(false);
            int tick = 0;
            while (m_supervisor_running && !m_reload.load()) {
                {
                    std::unique_lock<std::mutex> lk(m_supervisor_cv_mutex);
                    m_supervisor_cv.wait_for(lk, seconds(1),
                        [this] { return !m_supervisor_running.load() || m_reload.load(); });
                }
                if (!m_supervisor_running || m_reload.load()) break;
                ++tick;

                // Перезапускаем только слоты, которые работали и умерли на ходу;
                // слот с ошибкой старта поднимать бессмысленно, его правит оператор.
                // Исключение — камера (6006): она появляется в хранилище позже
                // слота или после своего перезапуска, пробуем раз в 5 секунд
                std::lock_guard<std::mutex> sl(m_loader_mutex);
                for (size_t i = 0; i < m_slots.size(); ++i) {
                    if (!m_slots[i] || m_slots[i]->is_running()) continue;
                    if (m_slots[i]->error_code() == 0)
                        restart_slot(i);
                    else if (m_slots[i]->error_code() == signaling::CODE_NEURAL_CAMERA && tick % 5 == 0)
                        m_slots[i]->start();
                }
            }

            if (!m_supervisor_running) break;
            m_logger.info("supervisor: state changed, rebuilding slots");
            cleanup_after_failure();
        }
        m_logger.info("supervisor: exiting");
    }

} // namespace neural
} // namespace varan