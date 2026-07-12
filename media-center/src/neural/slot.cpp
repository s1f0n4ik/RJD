#include "neural/slot.h"
#include "neural/draw-detections.h"

#include "signaling_definers.h"

#include "neural/tracker/iou-tracker.h"
#include "neural/constants.h"
#include "neural/utility.h"

#include <opencv2/imgcodecs.hpp>

#include <stdexcept>
#include <chrono>
#include <cmath>
#include <algorithm>
#include <ctime>
#include <cstdio>

namespace {
    std::int64_t now_ms() {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
    }

    std::string format_utc(std::int64_t unix_ms) {
        const std::time_t t = static_cast<std::time_t>(unix_ms / 1000);
        std::tm tm{};
#if defined(_WIN32)
        gmtime_s(&tm, &t);
#else
        gmtime_r(&t, &tm);
#endif
        char buf[32];
        std::strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &tm);
        return std::string(buf);
    }

    std::string format_coord(double v) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.5f", v);
        return std::string(buf);
    }

    // HEX "#RRGGBB" -> cv::Scalar(B, G, R) — для BGR-кадра (см. hex_to_rgb в draw-detections.h).
    cv::Scalar hex_to_bgr(const std::string& hex) {
        const cv::Scalar rgb = varan::neural::hex_to_rgb(hex);
        return cv::Scalar(rgb[2], rgb[1], rgb[0]);
    }
}

namespace varan {
namespace neural {

    USlot::USlot(
        const FConfigInfo& config,
        const FNeuralCoreConfig& core_config,
        birdview::UEGLContextManager* context,
        FFrameStorage<IFrame>* storage,
        FCameraMessageSender sender,
        FGatewayFrameSender gateway_sender,
        FGatewayTimeProvider time_provider,
        ULogger::ELoggerLevel level)
        : UImageHandler(context, storage, level, "ImageHandler<Slot:" + config.id + ">")
        , m_config(config)
        , m_cameras(layout_to_matrix(core_config.camera_layout))
        , m_layout(core_config.camera_layout)
        , m_npu_cores(core_config.npu_cores)
        , m_sender(std::move(sender))
        , m_gateway_sender(std::move(gateway_sender))
        , m_time_provider(std::move(time_provider))
    {
        // Камера-источник для тела сообщения шлюзу.
        if (!m_cameras.empty() && !m_cameras[0].empty()) {
            m_camera_id = m_cameras[0][0];
        }

        // Шрифт грузится только если слот реально отправляет кадры в шлюз.
        // Высота здесь — запасной вариант; draw_gateway_overlay() всегда передаёт
        // явную высоту (GATEWAY_DETECTION_FONT_HEIGHT / GATEWAY_OVERLAY_FONT_HEIGHT).
        if (m_gateway_sender) {
            m_text_renderer = std::make_unique<UTextRenderer>(constants::GATEWAY_DETECTION_FONT_HEIGHT, level);
        }

        if (auto tr_cfg = static_cast<FIoUTrackerConfig*>(config.tracker_config.get()); tr_cfg) {
            m_tracker = std::make_shared<UIoUTracker>(UIoUTracker(*tr_cfg));
        }
        else {
            m_tracker = nullptr;
        }

        // Стриминг включается только если у дескриптора задан блок streaming.
        // id/ip/port проставляет загрузчик до создания слота.
        if (core_config.streaming) {
            m_streaming_enabled = true;
            m_stream_name = core_config.streaming->name;
            m_stream_id = core_config.streaming->id;
            m_stream_ip = core_config.streaming->ip;
            m_stream_port = core_config.streaming->port;
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
        // Вызывающий ДОЛЖЕН держать m_resource_mutex.
        if (m_streamer) return true;

        if (m_stream_id.empty() || m_stream_ip.empty() || m_stream_port.empty()) {
            m_logger.error("ensure_streamer(): stream_id/ip/port not set");
            return false;
        }

        try {
            m_streamer = std::make_unique<UVirtualCamera>(
                m_stream_id, FWebSocketOptions{ m_stream_ip, m_stream_port }, m_logger.get_level());
            if (!m_streamer->set_parameters(width, height, 10))
                throw std::runtime_error("set_parameters failed");
            if (!m_streamer->initialize())
                throw std::runtime_error("initialize failed");
            if (!m_streamer->start())
                throw std::runtime_error("start failed");

            // Отображаемое имя стрима, если задано.
            if (!m_stream_name.empty())
                m_streamer->update_metadata(m_stream_name, "");

            m_logger.info("ensure_streamer(): started stream_id=" + m_stream_id +
                (m_stream_name.empty() ? "" : " name=" + m_stream_name));
        }
        catch (const std::exception& e) {
            m_logger.error("ensure_streamer(): " + std::string(e.what()));
            m_streamer.reset();
            return false;
        }
        return true;
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

    // Логирование событий, прошедших маску трекера (filter_events в update()).
    // Пока просто пишем в лог; позже здесь будет реальная реакция на событие.
    void USlot::log_events(const std::vector<FTrackEventRecord>& events) {
        for (const auto& e : events) {
            std::ostringstream ss;
            ss << "Event: " << track_event_str(e.event)
                << " track=" << e.track.id
                << " class=" << e.track.class_id
                << " conf=" << std::fixed << std::setprecision(2) << e.track.confidence
                << " bbox=("
                << e.track.detection.x1_coord << ","
                << e.track.detection.y1_coord << ","
                << e.track.detection.x2_coord << ","
                << e.track.detection.y2_coord << ")";
            m_logger.debug(ss.str());
        }
    }

    FGatewayDetection USlot::make_gateway_detection(int class_id, double confidence, const FDetection& det) const {
        FGatewayDetection g;
        g.cid = class_id;
        g.cf = confidence;

        for (const auto& cls : m_config.classes) {
            if (cls.id == class_id) {
                g.cls = cls.name;
                if (!cls.superclass.empty()) g.scls = cls.superclass;
                break;
            }
        }

        // Пиксельные координаты x, y, w, h — как ждёт протокол шлюза.
        const int x1 = static_cast<int>(std::lround(det.x1_coord));
        const int y1 = static_cast<int>(std::lround(det.y1_coord));
        const int x2 = static_cast<int>(std::lround(det.x2_coord));
        const int y2 = static_cast<int>(std::lround(det.y2_coord));
        g.box = { x1, y1, std::max(0, x2 - x1), std::max(0, y2 - y1) };
        return g;
    }

    std::vector<FGatewayDetection> USlot::gateway_dets_from_detections(const std::vector<FDetection>& dets) const {
        std::vector<FGatewayDetection> result;
        result.reserve(dets.size());
        for (const auto& d : dets) {
            result.push_back(make_gateway_detection(d.class_id, d.confidence, d));
        }
        return result;
    }

    std::vector<FGatewayDetection> USlot::gateway_dets_from_tracks(const std::vector<FTrack>& tracks) const {
        std::vector<FGatewayDetection> result;
        result.reserve(tracks.size());
        for (const auto& t : tracks) {
            // В шлюз идут подтверждённые объекты (и недавно потерянные) — как то,
            // что реально отображается; неподтверждённые треки не шлём.
            if (t.state != ETrackState::CONFIRMED && t.state != ETrackState::LOST) continue;
            result.push_back(make_gateway_detection(t.class_id, t.confidence, t.detection));
        }
        return result;
    }

    // Отрисовка на кадре, уходящем в message-gateway: бокс (цвет — по классу,
    // см. m_config.classes) + название класса (кириллица через m_text_renderer)
    // и время/GPS в левом верхнем углу.
    void USlot::draw_gateway_overlay(cv::Mat& frame_bgr, const std::vector<FGatewayDetection>& dets,
        const FGatewayTimeGps& time_gps)
    {
        if (frame_bgr.empty() || !m_text_renderer || !m_text_renderer->available()) return;

        const cv::Scalar fallback_color(0, 200, 0);
        const cv::Scalar text_color(255, 255, 255);

        // FreeType2::putText(..., bottomLeftOrigin=false) берёт org как ВЕРХНИЙ левый
        // угол текста, а не нижний — поэтому ниже везде считаем от верха вниз, а не
        // прибавляем ts.height к origin (это и была причина съезжающего текста).
        for (const auto& d : dets) {
            if (d.cls.empty()) continue;

            cv::Scalar box_color = fallback_color;
            for (const auto& c : m_config.classes) {
                if (c.id == d.cid) {
                    box_color = hex_to_bgr(c.color);
                    break;
                }
            }

            const cv::Rect r(d.box[0], d.box[1], d.box[2], d.box[3]);
            cv::rectangle(frame_bgr, r, box_color, 2);

            const int label_pad = 4;
            int baseline = 0;
            const cv::Size ts = m_text_renderer->text_size(d.cls, &baseline, constants::GATEWAY_DETECTION_FONT_HEIGHT);
            const int label_h = ts.height + baseline + label_pad * 2;
            const int ty = std::max(0, r.y - label_h);
            cv::rectangle(frame_bgr, cv::Rect(r.x, ty, ts.width + label_pad * 2, label_h), box_color, cv::FILLED);
            m_text_renderer->put_text(frame_bgr, d.cls, cv::Point(r.x + label_pad, ty + label_pad), text_color, constants::GATEWAY_DETECTION_FONT_HEIGHT);
        }

        const std::string time_line = "Время: " + format_utc(time_gps.unix_ms) + " UTC";
        const std::string gps_line = time_gps.valid
            ? ("GPS: " + format_coord(time_gps.lat) + ", " + format_coord(time_gps.lon))
            : std::string("GPS: нет данных");

        int baseline1 = 0, baseline2 = 0;
        const cv::Size ts1 = m_text_renderer->text_size(time_line, &baseline1, constants::GATEWAY_OVERLAY_FONT_HEIGHT);
        const cv::Size ts2 = m_text_renderer->text_size(gps_line, &baseline2, constants::GATEWAY_OVERLAY_FONT_HEIGHT);
        const int pad = 8;
        const int line1_h = ts1.height + baseline1;
        const int line2_h = ts2.height + baseline2;
        const int box_w = std::max(ts1.width, ts2.width) + pad * 2;
        const int box_h = pad * 3 + line1_h + line2_h; // верх + line1 + зазор + line2 + низ

        cv::rectangle(frame_bgr, cv::Rect(pad, pad, box_w, box_h), cv::Scalar(0, 0, 0), cv::FILLED);

        int line_y = pad + pad;
        m_text_renderer->put_text(frame_bgr, time_line, cv::Point(pad * 2, line_y), text_color, constants::GATEWAY_OVERLAY_FONT_HEIGHT);
        line_y += line1_h + pad;
        m_text_renderer->put_text(frame_bgr, gps_line, cv::Point(pad * 2, line_y), text_color, constants::GATEWAY_OVERLAY_FONT_HEIGHT);
    }

    // Кодирование кадра в JPEG и неблокирующая отправка в message-gateway.
    void USlot::send_to_gateway(std::vector<FGatewayDetection> dets, const cv::Mat& rgb_pixels) {
        if (!m_gateway_sender || rgb_pixels.empty()) return;

        cv::Mat bgr;
        cv::cvtColor(rgb_pixels, bgr, cv::COLOR_RGB2BGR);

        // Синхронизированное время шлюза, если доступно (точнее локальных часов
        // media-center); иначе локальное системное время как запасной вариант
        // (например, ещё не пришёл первый ответ GetTime после старта).
        FGatewayTimeGps time_gps = m_time_provider ? m_time_provider() : FGatewayTimeGps{};
        if (time_gps.unix_ms == 0) {
            time_gps.unix_ms = now_ms();
        }

        draw_gateway_overlay(bgr, dets, time_gps);

        std::vector<uchar> buf;
        const std::vector<int> params{ cv::IMWRITE_JPEG_QUALITY, 80 };
        if (!cv::imencode(".jpg", bgr, buf, params)) {
            m_logger.warn("send_to_gateway(): jpeg encode failed");
            return;
        }

        FGatewayFrame frame;
        frame.ver = 1;
        frame.id = ++m_frame_seq;
        frame.ts = time_gps.unix_ms;
        frame.width = rgb_pixels.cols;
        frame.height = rgb_pixels.rows;
        frame.format = "jpeg";
        frame.camera_id = m_camera_id;
        frame.image.assign(reinterpret_cast<const char*>(buf.data()), buf.size());
        frame.dets = std::move(dets);

        m_gateway_sender(std::move(frame));
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

                // Отправка кадра по протоколу в message-gateway (после отдачи в камеру).
                if (m_gateway_sender) {
                    send_to_gateway(gateway_dets_from_tracks(m_tracker->tracks()), rgb_pixels);
                }
            }

            send_tracks(m_tracker->tracks(), cv::Size(rgb_pixels.cols, rgb_pixels.rows));
        }
        else {
            send_detections(result.detections, cv::Size(rgb_pixels.cols, rgb_pixels.rows));

            // Нельзя отправлять каждый кадр, будет спам и просадка производительности
            //if (m_gateway_sender) {
            //    send_to_gateway(gateway_dets_from_detections(result.detections), rgb_pixels);
            //}
        }

        if (m_streaming_enabled) {
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