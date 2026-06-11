#include "neural/loader.h"
#include "neural/draw-detections.h"
#include "neural/constants.h"

#include <filesystem>

namespace varan {
namespace neural {

    UNeuralLoader::UNeuralLoader(
        const std::string& ip_address,
        const std::string& port,
        birdview::UEGLContextManager* context,
        FFrameStorage<IFrame>* storage,
        ULogger::ELoggerLevel level
    )
        : UImageHandler(context, storage, level, "ImageHandler<NeuralLoader>")
        , m_ip(ip_address)
        , m_port(port)
        , m_config_path(constants::CONFIG_PATH)
        , m_state_path(constants::STATE_PATH)
    {
        load_state();
    }

    UNeuralLoader::~UNeuralLoader() {
        stop_async_run();
    }

    bool UNeuralLoader::start_loader() {
        try {
            std::unique_lock<std::mutex> lock(m_loader_mutex);

            if (m_active_config_id.empty() || m_active_camera_id.empty()) {
                throw std::runtime_error("no active state: config_id or camera_id is empty");
            }

            auto config = m_json_configurator.load_config(m_active_config_id);
            if (!config) {
                throw std::runtime_error("No configuration with name=" + m_active_config_id);
            }
            m_active_config = config.value();

            if (!ensure_classifier()) {
                throw std::runtime_error("Cannot initialize Classifier");
            }

            if (!start_handler_thread(m_active_camera_id, m_active_config.fps, nullptr)) {
                throw std::runtime_error("Cannot start processing thread");
            }
            return true;
        }
        catch (const std::exception& error) {
            m_logger.error("start_loader(): " + std::string(error.what()));
            return false;
        }
    }

    bool UNeuralLoader::ensure_classifier() {
        if (m_classifier) return true;
        try {
            m_classifier = std::make_unique<Classifier>(
                m_active_config.model_path,
                m_active_config.classes,
                m_active_config.thresholds.nms,
                m_active_config.thresholds.confidence,
                &m_logger
            );
        }
        catch (const std::exception& e) {
            m_logger.error("ensure_classifier(): " + std::string(e.what()));
            m_classifier.reset();
            return false;
        }
        return true;
    }

    bool UNeuralLoader::start_streaming(int width, int height) {
        try {
            m_streamer = std::make_unique<neural::UVirtualCamera>(
                "neural_loader_1",
                FWebSocketOptions{ m_ip, m_port }
            );
            if (!m_streamer) { 
                throw std::runtime_error("NV12 encoder pipeline didn't create"); 
            }
            if (!m_streamer->set_parameters(width, height, 10)) {
                throw std::runtime_error("error with set up nv12 encoder parameters");
            }
            if (!m_streamer->initialize()) {
                throw std::runtime_error("NV12 encoder pipeline didn't set");
            }
            if (!m_streamer->start()) {
                throw std::runtime_error("NV12 encoder didn't start");
            }
            return true;
        }
        catch (const std::exception& error) {
            m_logger.error("start_streaming(): " + std::string(error.what()));
            if (m_streamer) m_streamer.reset();
            return false;
        }
    }

    void UNeuralLoader::handle_image_for_push(cv::Mat image) {
        if (!m_streamer && !image.empty()) {
            if (!start_streaming(image.cols, image.rows)) {
                m_logger.debug("handle_image_for_push(): cannot to start streaming!");
                return;
            }
        }
        if (m_streamer) m_streamer->push_frame(std::move(image));
    }

    void UNeuralLoader::internal_handle_image(cv::Mat rgb_pixels) {
        if (rgb_pixels.empty()) return;
        if (!ensure_classifier()) return;

        // Inference
        std::vector<uint8_t> mask;
        auto result = m_classifier->classify(rgb_pixels, mask);

        // Отрисовка bbox + маски прямо в кадр
        draw_detections(rgb_pixels, result.detections, mask, m_active_config.classes);

        // Push в виртуальную камеру
        handle_image_for_push(std::move(rgb_pixels));
    }

    bool UNeuralLoader::async_run() {
        if (m_supervisor_running.exchange(true)) {
            m_logger.warn("async_run(): already running");
            return false;
        }
        m_supervisor = std::thread(&UNeuralLoader::supervisor_loop, this);
        return true;
    }

    void UNeuralLoader::stop_async_run() {
        if (!m_supervisor_running.exchange(false)) return;

        // Будим supervisor, чтобы он сразу прервал ожидание backoff.
        m_supervisor_cv.notify_all();

        // Останавливаем активный handler, если он сейчас работает.
        if (is_running()) {
            stop_handler_thread();
        }

        if (m_supervisor.joinable()) m_supervisor.join();

        cleanup_after_failure();
    }

    void UNeuralLoader::cleanup_after_failure() {
        // streamer/classifier могут не освободиться сами, если start_loader умер посередине.
        // Освобождаем здесь, чтобы следующая попытка стартовала с чистого листа.
        if (m_streamer) {
            try { m_streamer->stop(); }
            catch (...) {}
            m_streamer.reset();
        }
        m_classifier.reset();
    }

    void UNeuralLoader::supervisor_loop() {
        using namespace std::chrono;

        int  backoff_ms = 1000;
        const int max_backoff_ms = 30000;

        while (m_supervisor_running) {
            m_logger.info("supervisor: starting loader...");
            bool started = false;

            try {
                started = start_loader();
            }
            catch (const std::exception& e) {
                m_logger.error("supervisor: start_loader threw: " + std::string(e.what()));
            }
            catch (...) {
                m_logger.error("supervisor: start_loader threw unknown exception");
            }

            if (!started) {
                cleanup_after_failure();
                m_logger.warn("supervisor: start failed, retry in " +
                    std::to_string(backoff_ms) + "ms");

                std::unique_lock<std::mutex> lk(m_supervisor_cv_mutex);
                m_supervisor_cv.wait_for(lk, milliseconds(backoff_ms),
                    [this] { return !m_supervisor_running.load(); });
                if (!m_supervisor_running) break;

                backoff_ms = std::min(backoff_ms * 2, max_backoff_ms);
                continue;
            }

            // Запуск удался — сбрасываем backoff, переходим в режим наблюдения.
            m_logger.info("supervisor: loader is running, watching...");
            backoff_ms = 1000;

            // Проверяем раз в секунду. Прерывается, если stop_async_run() позвал notify.
            while (m_supervisor_running && is_running()) {
                std::unique_lock<std::mutex> lk(m_supervisor_cv_mutex);
                m_supervisor_cv.wait_for(lk, seconds(1),
                    [this] { return !m_supervisor_running.load() || !is_running(); });
            }

            if (!m_supervisor_running) break;

            m_logger.warn("supervisor: loader stopped unexpectedly, will restart");
            cleanup_after_failure();
            // backoff остаётся 1s — после успешного запуска мы его сбросили.
        }

        m_logger.info("supervisor: exiting");
    }

    bool UNeuralLoader::write_state(const std::string& config_id, const std::string& camera_id) {
        if (config_id.empty() || camera_id.empty()) {
            m_logger.error("write_state(): empty config_id or camera_id");
            return false;
        }
        try {
            boost::json::object root;
            root["config_id"] = config_id;
            root["camera_id"] = camera_id;

            std::filesystem::create_directories(m_state_path.parent_path());
            std::ofstream f(m_state_path);
            f << boost::json::serialize(root);
        }
        catch (const std::exception& e) {
            m_logger.error("write_state(): " + std::string(e.what()));
            return false;
        }

        {
            std::lock_guard<std::mutex> lk(m_loader_mutex);
            m_active_config_id = config_id;
            m_active_camera_id = camera_id;
        }
        m_logger.info("write_state(): config_id=" + config_id + " camera_id=" + camera_id);
        return true;
    }

    boost::json::object UNeuralLoader::get_state_raw() const {
        boost::json::object result;
        try {
            if (!std::filesystem::exists(m_state_path)) return result;
            std::ifstream f(m_state_path);
            std::stringstream ss; ss << f.rdbuf();
            auto v = boost::json::parse(ss.str());
            if (v.is_object()) result = v.as_object();
        }
        catch (const std::exception& e) {
            m_logger.error("get_state_raw(): " + std::string(e.what()));
        }
        return result;
    }

    bool UNeuralLoader::load_state() {
        try {
            if (!std::filesystem::exists(m_state_path)) return false;
            std::ifstream f(m_state_path);
            std::stringstream ss; ss << f.rdbuf();
            auto v = boost::json::parse(ss.str());
            if (!v.is_object()) return false;
            const auto& obj = v.as_object();

            std::lock_guard<std::mutex> lk(m_loader_mutex);
            if (auto* c = obj.if_contains("config_id"); c && c->is_string()) {
                m_active_config_id = c->as_string().c_str();
            }
            if (auto* c = obj.if_contains("camera_id"); c && c->is_string()) {
                m_active_camera_id = c->as_string().c_str();
            }

            m_logger.info("load_state(): config_id=" + m_active_config_id + " camera_id=" + m_active_camera_id);
            return true;
        }
        catch (const std::exception& e) {
            m_logger.error("load_state(): " + std::string(e.what()));
            return false;
        }
    }

    bool UNeuralLoader::reload_from_state() {
        return load_state();
    }

    std::vector<UNeuralLoader::FNeuralExports> UNeuralLoader::list_configurations() const {
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
                if (auto* n = val.as_object().if_contains("name"); n && n->is_string()) {
                    info.name = n->as_string().c_str();
                }
                else {
                    info.name = info.id;
                }
                result.push_back(std::move(info));
            }
        }
        catch (const std::exception& e) {
            m_logger.error("list_configurations(): " + std::string(e.what()));
        }
        return result;
    }

    bool UNeuralLoader::import_configurations(const boost::json::value& json, EImportMode mode) {
        if (!json.is_object()) {
            m_logger.error("import_configurations(): payload must be object");
            return false;
        }

        try {
            boost::json::object final_obj;

            if (mode == EImportMode::REPLACE_ALL) {
                final_obj = json.as_object();
            }
            else { // MERGE
                // Прочитать существующий файл, если есть
                if (std::filesystem::exists(m_config_path)) {
                    std::ifstream f(m_config_path);
                    std::stringstream ss; ss << f.rdbuf();
                    auto existing = boost::json::parse(ss.str());
                    if (existing.is_object()) final_obj = existing.as_object();
                }
                // Дописать/перезаписать ключи из json
                for (const auto& [k, v] : json.as_object()) {
                    final_obj[std::string(k)] = v;
                }
            }

            std::filesystem::create_directories(m_config_path.parent_path());
            std::ofstream f(m_config_path);
            f << boost::json::serialize(final_obj);
        }
        catch (const std::exception& e) {
            m_logger.error("import_configurations(): " + std::string(e.what()));
            return false;
        }

        m_logger.info("import_configurations(): mode=" + std::string(mode == EImportMode::REPLACE_ALL ? "REPLACE_ALL" : "MERGE"));
        return true;
    }

    bool UNeuralLoader::is_running() const {
        return m_supervisor_running.load();
    }

    bool UNeuralLoader::restart() {
        if (!m_supervisor_running.load()) {
            return async_run();
        }
        reload_from_state();
        // Останавливаем активный handler — supervisor увидит и пойдёт на новый круг.
        if (UImageHandler::is_running()) {
            stop_handler_thread();
        }
        // supervisor сам поднимется
        return true;
    }

    std::string UNeuralLoader::get_active_config_id() const {
        std::lock_guard<std::mutex> lock(m_loader_mutex);
        return m_active_config_id;
    }

    std::string UNeuralLoader::get_active_camera_id() const {
        std::lock_guard<std::mutex> lock(m_loader_mutex);
        return m_active_camera_id;
    }

} // namespace neural
} // namespace varan