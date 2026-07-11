#include "neural/slot.h"
#include "neural/draw-detections.h"

#include "signaling_definers.h"

#include "neural/tracker/iou-tracker.h"
#include "neural/utility.h"

#include <stdexcept>

namespace varan {
namespace neural {

    USlot::USlot(
        const FConfigInfo& config,
        const FNeuralCoreConfig& core_config,
        birdview::UEGLContextManager* context,
        FFrameStorage<IFrame>* storage,
        FCameraMessageSender sender,
        ULogger::ELoggerLevel level)
        : UImageHandler(context, storage, level, "ImageHandler<Slot:" + config.id + ">")
        , m_config(config)
        , m_cameras(layout_to_matrix(core_config.camera_layout))
        , m_layout(core_config.camera_layout)
        , m_npu_cores(core_config.npu_cores)
        , m_sender(std::move(sender))
    {
        if (auto tr_cfg = static_cast<FIoUTrackerConfig*>(config.tracker_config.get()); tr_cfg) {
            m_tracker = std::make_shared<UIoUTracker>(UIoUTracker(*tr_cfg));
        }
        else {
            m_tracker = nullptr;
        }
    }

    USlot::~USlot() {
        stop();
    }

    bool USlot::ensure_classifier() {
        // Вызывающий ДОЛЖЕН держать m_resource_mutex.
        if (m_classifier) return true;
        try {
            m_classifier = std::make_unique<Classifier>(
                m_config.model_path,
                m_config.classes,
                m_config.thresholds.nms,
                m_config.thresholds.confidence,
                m_npu_cores,
                &m_logger);
        }
        catch (const std::exception& e) {
            m_logger.error("ensure_classifier(): " + std::string(e.what()));
            return false;
        }
        return true;
    }

    bool USlot::ensure_streamer(int width, int height) {
        return false;
        // Вызывающий ДОЛЖЕН держать m_resource_mutex.
        /*
        if (m_streamer) return true;
        try {
            m_streamer = std::make_unique<UVirtualCamera>(
                m_stream_id, FWebSocketOptions{ m_ip, m_port });
            if (!m_streamer->set_parameters(width, height, 10))
                throw std::runtime_error("set_parameters failed");
            if (!m_streamer->initialize())
                throw std::runtime_error("initialize failed");
            if (!m_streamer->start())
                throw std::runtime_error("start failed");
        }
        catch (const std::exception& e) {
            m_logger.error("ensure_streamer(): " + std::string(e.what()));
            m_streamer.reset();
            return false;
        }
        return true;
        */
    }

    bool USlot::start() {
        {
            std::lock_guard<std::mutex> lk(m_resource_mutex);
            if (!ensure_classifier()) return false;
        }

        if (m_cameras.empty() || m_cameras[0].empty()) {
            m_logger.error("start(): no cameras");
            return false;
        }

        if (!is_single_camera(m_cameras)) {
            m_logger.warn("start(): mosaic NOT YET implemented, using first camera");
        }

        const std::string& camera_id = m_cameras[0][0];
        if (!start_handler_thread(camera_id, 10, nullptr)) {
            m_logger.error("start(): cannot start handler thread");
            return false;
        }

        std::string cores_str;
        for (int c : m_npu_cores) cores_str += std::to_string(c) + ",";
        if (!cores_str.empty()) cores_str.pop_back();

        m_logger.info("start(): slot=" + m_config.id +
            " camera=" + camera_id +
            " cores=[" + cores_str + "]" +
            " stream=" + m_stream_id);
        return true;
    }

    void USlot::stop() {
        // Сначала останавливаем поток обработки — после этого
        // internal_handle_image() гарантированно не вызывается.
        if (is_running()) stop_handler_thread();

        // Теперь безопасно освобождаем ресурсы.
        std::lock_guard<std::mutex> lk(m_resource_mutex);
        if (m_streamer) {
            try { m_streamer->stop(); }
            catch (...) {}
            m_streamer.reset();
        }
        m_classifier.reset();
    }

    inline std::string serialize_detection(const FDetection& d) {
        std::ostringstream ss;
        ss << std::fixed << std::setprecision(3);
        ss << "Detection{"
            << " bbox=("
            << d.x1_coord << ", "
            << d.y1_coord << ", "
            << d.x2_coord << ", "
            << d.y2_coord << "),"
            << " confidence=" << d.confidence
            << ", class_id=" << d.class_id
            << " }";
        return ss.str();
    }

    void USlot::send_detections(const std::vector<FDetection>& detections, const cv::Size& resolution) {
        if (!m_sender) return;

        const float img_w = static_cast<float>(resolution.width);
        const float img_h = static_cast<float>(resolution.height);

        boost::json::array dets_arr;
        for (const auto& det : detections) {
            std::string superclass_key;
            std::string class_name;
            std::string class_color;

            for (const auto& cls : m_config.classes) {
                if (cls.id == det.class_id) {
                    class_name = cls.name;
                    superclass_key = cls.superclass;
                    class_color = cls.color;
                    break;
                }
            }

            boost::json::object d;
            d["id"] = det.class_id;
            d["name"] = class_name;
            d["color"] = class_color;
            d["superclass"] = superclass_key;
            d["confidence"] = det.confidence;

            boost::json::array rect;
            rect.emplace_back(img_w > 0 ? det.x1_coord / img_w : 0.0f);
            rect.emplace_back(img_h > 0 ? det.y1_coord / img_h : 0.0f);
            rect.emplace_back(img_w > 0 ? det.x2_coord / img_w : 0.0f);
            rect.emplace_back(img_h > 0 ? det.y2_coord / img_h : 0.0f);
            d["rect"] = std::move(rect);

            dets_arr.push_back(std::move(d));
        }

        boost::json::object meta;
        meta["detections"] = std::move(dets_arr);

        const std::string msg = make_socket_message("neural", true, nullptr, nullptr, &meta);
        m_sender(msg);
    }

    // Отправка всех треков по WebSocket
    void USlot::send_tracks(const std::vector<FTrack>& tracks,
        const cv::Size& resolution)
    {
        if (!m_sender) return;

        const float img_w = static_cast<float>(resolution.width);
        const float img_h = static_cast<float>(resolution.height);

        boost::json::array tracks_arr;
        for (const auto& t : tracks) {
            // Ищем метаданные класса
            std::string superclass_key, class_name, class_color;
            for (const auto& cls : m_config.classes) {
                if (cls.id == t.class_id) {
                    class_name = cls.name;
                    superclass_key = cls.superclass;
                    class_color = cls.color;
                    break;
                }
            }

            boost::json::object obj;
            obj["track_id"] = t.id;
            obj["class_id"] = t.class_id;
            obj["name"] = class_name;
            obj["color"] = class_color;
            obj["superclass"] = superclass_key;
            obj["confidence"] = t.confidence;
            obj["state"] = track_state_str(t.state);
            obj["age"] = t.age;
            obj["lost_frames"] = t.lost_frames;

            // Нормализованные координаты [x1, y1, x2, y2]
            boost::json::array rect;
            rect.emplace_back(img_w > 0 ? t.detection.x1_coord / img_w : 0.0f);
            rect.emplace_back(img_h > 0 ? t.detection.y1_coord / img_h : 0.0f);
            rect.emplace_back(img_w > 0 ? t.detection.x2_coord / img_w : 0.0f);
            rect.emplace_back(img_h > 0 ? t.detection.y2_coord / img_h : 0.0f);
            obj["rect"] = std::move(rect);

            tracks_arr.push_back(std::move(obj));
        }

        boost::json::object meta;
        meta["tracks"] = std::move(tracks_arr);

        const std::string msg = make_socket_message("neural_tracks", true, nullptr, nullptr, &meta);
        m_sender(msg);
    }

    // Логирование событий
    void USlot::log_events(const std::vector<FTrackEventRecord>& events) {
        for (const auto& e : events) {
            std::ostringstream ss;
            ss << "track[" << e.track.id << "] "
                << track_event_str(e.event)
                << " class=" << e.track.class_id
                << " conf=" << std::fixed << std::setprecision(2) << e.track.confidence
                << " bbox=("
                << e.track.detection.x1_coord << ","
                << e.track.detection.y1_coord << ","
                << e.track.detection.x2_coord << ","
                << e.track.detection.y2_coord << ")";
            m_logger.trace(ss.str());
        }
    }

    void USlot::internal_handle_image(cv::Mat rgb_pixels) {
        if (rgb_pixels.empty()) return;

        // FIX: весь доступ к m_classifier и m_streamer под мьютексом.
        // Это предотвращает гонку с stop(), который делает reset().
        std::lock_guard<std::mutex> lk(m_resource_mutex);

        if (!ensure_classifier()) return;

        std::vector<uint8_t> mask;
        auto result = m_classifier->classify(rgb_pixels, mask);

        if (m_tracker) {
            auto update_result = m_tracker->update(result.detections, rgb_pixels.cols, rgb_pixels.rows);
            if (update_result.has_events()) {
                log_events(update_result.events);
            }

            send_tracks(m_tracker->tracks(), cv::Size(rgb_pixels.cols, rgb_pixels.rows));
        }
        else {
            send_detections(result.detections, cv::Size(rgb_pixels.cols, rgb_pixels.rows));
        }

        if (m_config.enable_raw_stream) {
            std::vector<FDetection> draw_dets;

            if (m_tracker) {
                for (const auto& t : m_tracker->tracks()) {
                    if (t.state == ETrackState::CONFIRMED || t.state == ETrackState::LOST) {
                        draw_dets.push_back(t.detection);
                    }
                }
            }
            else { draw_dets = std::move(result.detections); }

            draw_detections_grouped(rgb_pixels, draw_dets, mask, m_config.classes, m_config.superclasses);

            if (ensure_streamer(rgb_pixels.cols, rgb_pixels.rows)) {
                m_streamer->push_frame(std::move(rgb_pixels));
            }
        }
    }

} // namespace neural
} // namespace varan