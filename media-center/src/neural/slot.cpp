#include "neural/slot.h"
#include "neural/draw-detections.h"

#include "signaling_definers.h"

#include <stdexcept>

namespace varan {
namespace neural {

    USlot::USlot(
        const FConfigInfo& config,
        const FCameraMatrix& cameras,
        const std::vector<int>& npu_cores,
        const std::string& stream_id,
        const std::string& ip,
        const std::string& port,
        birdview::UEGLContextManager* context,
        FFrameStorage<IFrame>* storage,
        FCameraMessageSender sender,
        ULogger::ELoggerLevel level)
        : UImageHandler(context, storage, level, "ImageHandler<Slot:" + config.id + ">")
        , m_config(config)
        , m_cameras(cameras)
        , m_npu_cores(npu_cores)
        , m_stream_id(stream_id)
        , m_ip(ip)
        , m_port(port)
        , m_sender(std::move(sender))
    {}

    USlot::~USlot() {
        stop();
    }

    bool USlot::ensure_classifier() {
        if (m_classifier) return true;
        try {
            m_classifier = std::make_unique<Classifier>(
                m_config.model_path,
                m_config.classes,
                m_config.thresholds.nms,
                m_config.thresholds.confidence,
                m_npu_cores,             // ← из state
                &m_logger);
        }
        catch (const std::exception& e) {
            m_logger.error("ensure_classifier(): " + std::string(e.what()));
            return false;
        }
        return true;
    }

    bool USlot::ensure_streamer(int width, int height) {
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
    }

    bool USlot::start() {
        if (!ensure_classifier()) return false;

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
        if (is_running()) stop_handler_thread();
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
            // Находим суперкласс через классы конфига
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

            // rect: нормализованные координаты [x1, y1, x2, y2]
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

    void USlot::internal_handle_image(cv::Mat rgb_pixels) {
        if (rgb_pixels.empty()) return;
        if (!ensure_classifier()) return;

        std::vector<uint8_t> mask;
        auto result = m_classifier->classify(rgb_pixels, mask);

        if (result.detections.size() == 0) {
            //
        }
        else {
            std::ostringstream detections;
            detections << "classify(): founded detections: \n";
            for (const auto& detect : result.detections) {
                detections << "\t" << serialize_detection(detect) << "\n";
            }
            m_logger.trace(detections.str());
        }

        send_detections(result.detections, cv::Size(rgb_pixels.cols, rgb_pixels.rows));

        draw_detections_grouped(rgb_pixels, result.detections, mask,
            m_config.classes, m_config.superclasses);

        if (!ensure_streamer(rgb_pixels.cols, rgb_pixels.rows)) return;
        if (m_streamer) m_streamer->push_frame(std::move(rgb_pixels));
    }

} // namespace neural
} // namespace varan