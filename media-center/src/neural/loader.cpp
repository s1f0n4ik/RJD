#include "neural/loader.h"
#include "neural/draw-detections.h"

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
    {}

    UNeuralLoader::~UNeuralLoader() {
        stop_async_run();
    }

    bool UNeuralLoader::start_loader() {
        try {
            std::unique_lock<std::mutex> lock(m_loader_mutex);

            auto config_path = std::filesystem::path("/home/orangepi/varan/neural/configurations.json");
            std::filesystem::create_directories(config_path.parent_path());
            if (!m_json_configurator.read(config_path)) {
                throw std::runtime_error("Cannot read configurations at " + config_path.string());
            }

            std::string conf_name = "railway_camera";
            auto config = m_json_configurator.load_config(conf_name);
            if (!config) {
                throw std::runtime_error("No configuration with name=" + conf_name);
            }
            m_active_config = config.value();

            if (!ensure_classifier()) {
                throw std::runtime_error("Cannot initialize Classifier");
            }

            if (!start_handler_thread(m_active_config.camera_id, 10, nullptr)) {
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

} // namespace neural
} // namespace varan