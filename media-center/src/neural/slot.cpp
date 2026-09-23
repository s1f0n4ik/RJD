#include "neural/slot.h"
#include "neural/draw-detections.h"

#include "signaling_definers.h"

#include "neural/tracker/iou-tracker.h"
#include "neural/constants.h"
#include "neural/postprocess.h"
#include "neural/utility.h"

#include <opencv2/imgcodecs.hpp>

#include <stdexcept>
#include <chrono>
#include <cmath>
#include <algorithm>
#include <ctime>
#include <cstdio>
#include <fstream>
#include <filesystem>

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

    // Дата UTC "YYYY-MM-DD" из unix-мс — для раскладки кадров журнала по дням.
    std::string format_date(std::int64_t unix_ms) {
        const std::time_t t = static_cast<std::time_t>(unix_ms / 1000);
        std::tm tm{};
#if defined(_WIN32)
        gmtime_s(&tm, &t);
#else
        gmtime_r(&t, &tm);
#endif
        char buf[16];
        std::strftime(buf, sizeof(buf), "%Y-%m-%d", &tm);
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
        const FVideoStream& video,
        birdview::UEGLContextManager* context,
        FFrameStorage<IFrame>* storage,
        FCameraSenderProvider sender_provider,
        gateway::FGatewayFrameSender gateway_sender,
        gateway::FGatewayTimeProvider time_provider,
        journal::FSlotJournal journal,
        ULogger::ELoggerLevel level)
        : m_config(config)
        , m_video(video)
        , m_depth(std::max(1, core_config.depth))
        , m_fps_limit(std::max(1, core_config.fps))
        , m_context(context)
        , m_storage(storage)
        , m_level(level)
        , m_logger("Slot:" + config.id + "/" + video.id, level)
        , m_sender_provider(std::move(sender_provider))
        , m_gateway_sender(std::move(gateway_sender))
        , m_time_provider(std::move(time_provider))
        , m_journal(std::move(journal))
    {
        m_text_renderer = std::make_unique<UTextRenderer>(constants::GATEWAY_DETECTION_FONT_HEIGHT, level);

        for (const auto& cam : stream_cameras(m_video))
            m_trackers[cam] = make_tracker();

        // Стриминг включается только если у дескриптора задан блок streaming
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

    std::shared_ptr<IDetectionTracker> USlot::make_tracker() const {
        if (auto tr_cfg = static_cast<FIoUTrackerConfig*>(m_config.tracker_config.get()); tr_cfg)
            return std::make_shared<UIoUTracker>(*tr_cfg);
        return nullptr;
    }

    FCameraMessageSender& USlot::sender_for(const std::string& camera) {
        std::lock_guard<std::mutex> lk(m_senders_mutex);
        auto it = m_senders.find(camera);
        if (it == m_senders.end())
            it = m_senders.emplace(camera, m_sender_provider ? m_sender_provider(camera) : FCameraMessageSender{}).first;
        return it->second;
    }

    bool USlot::is_running() const {
        return m_composer && m_composer->is_running();
    }

    FCanvasInfo USlot::tiles() const {
        return m_composer ? m_composer->tiles() : FCanvasInfo{};
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
                m_depth,
                &m_logger
            );
        }
        catch (const FNeuralError& e) {
            set_error(e.code, e.what());
            return false;
        }
        catch (const std::exception& e) {
            set_error(signaling::CODE_NEURAL_INIT, e.what());
            return false;
        }
        return true;
    }

    void USlot::set_error(int code, const std::string& message) {
        m_logger.error("slot " + m_config.id + ": [" + std::to_string(code) + "] " + message);
        std::lock_guard<std::mutex> lk(m_error_mutex);
        m_error_code.store(code);
        m_error = message;
    }

    std::string USlot::error() const {
        std::lock_guard<std::mutex> lk(m_error_mutex);
        return m_error;
    }

    int USlot::depth_actual() const {
        std::lock_guard<std::mutex> lk(m_resource_mutex);
        return m_classifier ? m_classifier->depth_actual() : 0;
    }

    std::string USlot::model_layout() const {
        std::lock_guard<std::mutex> lk(m_resource_mutex);
        return m_classifier ? m_classifier->layout() : std::string();
    }

    const FModelInfo* USlot::model_info() const {
        std::lock_guard<std::mutex> lk(m_resource_mutex);
        return m_classifier ? &m_classifier->info() : nullptr;
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

            // Отображаемое имя стрима, если задано
            if (!m_stream_name.empty())
                m_streamer->update_metadata(m_stream_name, "");

            m_stream_width.store(width);
            m_stream_height.store(height);

            m_logger.info("ensure_streamer(): started stream_id=" + m_stream_id +
                (m_stream_name.empty() ? "" : " name=" + m_stream_name));
        }
        catch (const std::exception& e) {
            set_error(signaling::CODE_NEURAL_STREAMER, std::string("ensure_streamer(): ") + e.what());
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

        const auto cameras = stream_cameras(m_video);
        if (cameras.empty()) {
            set_error(signaling::CODE_NEURAL_CAMERA, "no cameras in stream " + m_video.id);
            return false;
        }
        std::string missing;
        int present = 0;
        for (const auto& cam : cameras) {
            if (m_storage && m_storage->is_exists(cam)) ++present;
            else missing += (missing.empty() ? "" : ", ") + cam;
        }
        if (present == 0) {
            set_error(signaling::CODE_NEURAL_CAMERA, "no cameras in storage: " + missing);
            return false;
        }
        if (!missing.empty()) m_logger.warn("start(): cameras not in storage yet: " + missing);

        // Фоновый воркер кадров поднимаем до обработки: он снимает кодирование
        // JPEG и запись файлов с потока инференса.
        if (!m_frame_running.exchange(true)) {
            m_frame_thread = std::thread(&USlot::frame_worker, this);
        }

        m_infer_seq = 0;
        m_next_seq = 1;
        m_pending.clear();
        m_fps_window = std::chrono::steady_clock::now();
        m_fps_count = 0;
        if (!m_infer_running.exchange(true)) {
            for (int i = 0; i < m_depth; ++i)
                m_infer_threads.emplace_back(&USlot::infer_worker, this);
        }

        // Полотно ровно под вход модели: леттербокс в классификаторе вырождается в копию
        int width = 640;
        int height = 640;
        {
            std::lock_guard<std::mutex> lk(m_resource_mutex);
            const auto& info = m_classifier->info();
            if (info.input_width > 0 && info.input_height > 0) {
                width = info.input_width;
                height = info.input_height;
            }
        }
        m_canvas_width.store(width);
        m_canvas_height.store(height);

        m_composer = std::make_unique<UCanvasComposer>(
            m_context, m_storage, width, height, m_video,
            [this](cv::Mat rgba, FCanvasInfo tiles) { on_canvas(std::move(rgba), std::move(tiles)); },
            m_level, "Canvas<" + m_config.id + "/" + m_video.id + ">");
        if (!m_composer->start(m_fps_limit)) {
            m_composer.reset();
            set_error(signaling::CODE_NEURAL_CANVAS, "canvas composer didn't start");
            return false;
        }

        // Камера могла появиться после неудачного старта — ошибка снята
        {
            std::lock_guard<std::mutex> lk(m_error_mutex);
            m_error_code.store(0);
            m_error.clear();
        }

        m_logger.info("start(): slot=" + m_config.id +
            " stream=" + m_video.id +
            " canvas=" + std::to_string(width) + "x" + std::to_string(height) +
            " tiles=" + std::to_string(m_video.tiles.size()) +
            " fps<=" + std::to_string(m_fps_limit) +
            " depth=" + std::to_string(m_depth) + "/" + std::to_string(depth_actual()) +
            " layout=" + model_layout() +
            " output=" + m_stream_id);
        return true;
    }

    void USlot::stop() {
        if (m_composer) {
            m_composer->stop();
            m_composer.reset();
        }

        if (m_infer_running.exchange(false)) {
            m_infer_cv.notify_all();
            for (auto& t : m_infer_threads) if (t.joinable()) t.join();
            m_infer_threads.clear();
            std::lock_guard<std::mutex> lk(m_infer_mutex);
            m_infer_queue.clear();
        }

        bool frame_was_running = false;
        {
            // Флаг меняется под мьютексом воркера
            std::lock_guard<std::mutex> lk(m_frame_mutex);
            frame_was_running = m_frame_running.exchange(false);
        }
        if (frame_was_running) {
            m_frame_cv.notify_all();
            if (m_frame_thread.joinable()) m_frame_thread.join();
        }

        // Теперь безопасно освобождаем ресурсы.
        std::lock_guard<std::mutex> lk(m_resource_mutex);
        if (m_streamer) {
            try { m_streamer->stop(); }
            catch (...) {}
            m_streamer.reset();
            // Размер принадлежал выводу, которого больше нет
            m_stream_width.store(0);
            m_stream_height.store(0);
        }
        m_classifier.reset();

        std::lock_guard<std::mutex> dl(m_deliver_mutex);
        for (auto& [cam, tracker] : m_trackers) if (tracker) tracker->reset();
        m_pending.clear();
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

    void USlot::send_detections(const std::string& camera, const std::vector<FDetection>& detections, const cv::Size& resolution) {
        auto& sender = sender_for(camera);
        if (!sender) return;

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
        meta["source"] = m_video.id;
        meta["source_name"] = m_video.name;

        const std::string msg = make_socket_message("neural", true, nullptr, nullptr, &meta);
        sender(msg);
    }

    void USlot::send_tracks(const std::string& camera, const std::vector<FTrack>& tracks,
        const cv::Size& resolution)
    {
        auto& sender = sender_for(camera);
        if (!sender) return;

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
        meta["source"] = m_video.id;
        meta["source_name"] = m_video.name;

        const std::string msg = make_socket_message("neural_tracks", true, nullptr, nullptr, &meta);
        sender(msg);
    }

    // Логирование событий, прошедших маску трекера filter_events
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

    gateway::FGatewayDetection USlot::make_gateway_detection(int class_id, double confidence, const FDetection& det) const {
        gateway::FGatewayDetection g;
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

    std::vector<gateway::FGatewayDetection> USlot::gateway_dets_from_detections(const std::vector<FDetection>& dets) const {
        std::vector<gateway::FGatewayDetection> result;
        result.reserve(dets.size());
        for (const auto& d : dets) {
            result.push_back(make_gateway_detection(d.class_id, d.confidence, d));
        }
        return result;
    }

    std::vector<gateway::FGatewayDetection> USlot::gateway_dets_from_tracks(const std::vector<FTrack>& tracks) const {
        std::vector<gateway::FGatewayDetection> result;
        result.reserve(tracks.size());
        for (const auto& t : tracks) {
            // В шлюз идут подтверждённые объекты и недавно потерянные
            if (t.state != ETrackState::CONFIRMED && t.state != ETrackState::LOST) continue;
            result.push_back(make_gateway_detection(t.class_id, t.confidence, t.detection));
        }
        return result;
    }

    // Отрисовка на кадре, уходящем в message-gateway: бокс (цвет — по классу,
    // см. m_config.classes) + название класса (кириллица через m_text_renderer)
    // и время/GPS в левом верхнем углу.
    void USlot::draw_gateway_overlay(cv::Mat& frame_bgr, const std::vector<gateway::FGatewayDetection>& dets,
        const gateway::FGatewayTimeGps& time_gps)
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

    // Сбор задачи на потоке доставки: только метаданные, кадр камеры придёт снимком
    USlot::FFrameTask USlot::make_frame_task(const std::string& camera, const cv::Size& resolution,
        const IDetectionTracker& tracker, const std::vector<FTrackEventRecord>& events)
    {
        FFrameTask task;
        task.camera = camera;
        task.width = resolution.width;
        task.height = resolution.height;
        task.seq = ++m_frame_seq;

        // Синхронизированное время шлюза, иначе локальные часы как запасной вариант.
        task.time_gps = m_time_provider ? m_time_provider() : gateway::FGatewayTimeGps{};
        if (task.time_gps.unix_ms == 0) task.time_gps.unix_ms = now_ms();

        // Типы сработавших событий — в запись журнала, для контекста.
        for (const auto& e : events) {
            const std::string name = track_event_str(e.event);
            if (task.events.find(name) == std::string::npos) {
                if (!task.events.empty()) task.events += ",";
                task.events += name;
            }
        }

        {
            for (const auto& t : tracker.tracks()) {
                const int x1 = static_cast<int>(std::lround(t.detection.x1_coord));
                const int y1 = static_cast<int>(std::lround(t.detection.y1_coord));
                const int x2 = static_cast<int>(std::lround(t.detection.x2_coord));
                const int y2 = static_cast<int>(std::lround(t.detection.y2_coord));

                // Журнал: ВСЕ треки кадра со своим состоянием (временный/
                // подтверждённый/потерянный) — маска событий уже отсеяла лишнее.
                journal::FDetectionObject o;
                o.cid = t.class_id;
                o.cf = t.confidence;
                o.box = { x1, y1, std::max(0, x2 - x1), std::max(0, y2 - y1) };
                o.state = track_state_str(t.state);
                task.objects.push_back(std::move(o));

                // Шлюз: по протоколу только подтверждённые и недавно потерянные.
                if (t.state == ETrackState::CONFIRMED || t.state == ETrackState::LOST) {
                    task.gw_dets.push_back(make_gateway_detection(t.class_id, t.confidence, t.detection));
                }
            }
        }
        return task;
    }

    void USlot::enqueue_frame(FFrameTask task) {
        FFrameTask dropped;
        bool has_dropped = false;
        {
            std::lock_guard<std::mutex> lk(m_frame_mutex);
            if (m_frame_queue.size() >= kFrameQueue) {
                dropped = std::move(m_frame_queue.front());
                m_frame_queue.pop_front();
                has_dropped = true;
            }
            m_frame_queue.push_back(std::move(task));
        }

        if (has_dropped) {
            // Картинку теряем, а событие — нет: строку в журнал пишем всё равно,
            // просто без изображения. Это дёшево, кодирования тут не происходит.
            m_logger.warn("frame queue overflow: image dropped, row kept");
            dropped.rgb.release();
            journal_row(dropped, std::string());
        }
        m_frame_cv.notify_one();
    }

    void USlot::frame_worker() {
        while (true) {
            std::deque<FFrameTask> batch;
            {
                std::unique_lock<std::mutex> lk(m_frame_mutex);
                m_frame_cv.wait(lk, [this] { return !m_frame_queue.empty() || !m_frame_running.load(); });
                if (!m_frame_running.load() && m_frame_queue.empty()) break;
                batch.swap(m_frame_queue);
            }
            for (const auto& task : batch) process_frame_task(task);
        }
    }

    void USlot::process_frame_task(const FFrameTask& task) {
        if (task.rgb.empty()) return;

        cv::Mat bgr;
        cv::cvtColor(task.rgb, bgr, cv::COLOR_RGB2BGR);

        // 1) Журнал — ЧИСТЫЙ кадр: без боксов и без оверлея времени/GPS. Такие
        // кадры пригодны для дообучения, а боксы фронт рисует поверх сам —
        // координаты и id классов лежат в БД.
        if (m_journal.enabled()) {
            std::vector<uchar> buf;
            const std::vector<int> params{ cv::IMWRITE_JPEG_QUALITY, 85 };
            if (!cv::imencode(".jpg", bgr, buf, params)) {
                m_logger.warn("journal: jpeg encode failed, row kept without image");
                journal_row(task, std::string());
            }
            else {
                const std::string date = format_date(task.time_gps.unix_ms);
                const std::string name = std::to_string(task.time_gps.unix_ms) + "-" +
                    std::to_string(task.seq) + ".jpg";
                const std::filesystem::path abs = m_journal.frames_dir / date / name;

                std::error_code ec;
                std::filesystem::create_directories(abs.parent_path(), ec);
                std::ofstream f(abs, std::ios::binary);
                if (!f) {
                    m_logger.warn("journal: cannot write " + abs.string() + ", row kept without image");
                    journal_row(task, std::string());
                }
                else {
                    f.write(reinterpret_cast<const char*>(buf.data()), static_cast<std::streamsize>(buf.size()));
                    f.close();
                    journal_row(task, date + "/" + name);
                }
            }
        }

        // 2) Шлюз — аннотированный кадр (боксы + время/GPS), как требует протокол.
        if (m_gateway_sender) {
            cv::Mat annotated = bgr.clone();
            draw_gateway_overlay(annotated, task.gw_dets, task.time_gps);

            std::vector<uchar> buf;
            const std::vector<int> params{ cv::IMWRITE_JPEG_QUALITY, 80 };
            if (!cv::imencode(".jpg", annotated, buf, params)) {
                m_logger.warn("gateway: jpeg encode failed");
                return;
            }

            gateway::FGatewayFrame frame;
            frame.ver = 1;
            frame.id = task.seq;
            frame.ts = task.time_gps.unix_ms;
            frame.width = task.width;
            frame.height = task.height;
            frame.format = "jpeg";
            frame.camera_id = task.camera;
            frame.config_id = config_id();
            frame.image.assign(reinterpret_cast<const char*>(buf.data()), buf.size());
            frame.dets = task.gw_dets;

            m_gateway_sender(std::move(frame));
        }
    }

    void USlot::journal_row(const FFrameTask& task, const std::string& image_path) {
        if (!m_journal.enabled()) return;
        if (task.objects.empty()) return;

        journal::FEntry entry;
        entry.ts = task.time_gps.unix_ms;
        entry.camera_id = task.camera;
        entry.config_id = config_id();
        entry.gps_valid = task.time_gps.valid;
        entry.lat = task.time_gps.lat;
        entry.lon = task.time_gps.lon;
        entry.alt = task.time_gps.alt;
        entry.speed = task.time_gps.speed;
        entry.course = task.time_gps.course;
        entry.width = task.width;
        entry.height = task.height;
        entry.image_path = image_path;
        entry.event = task.events;
        entry.objects = task.objects;

        m_journal.sink(std::move(entry));
    }

    void USlot::on_canvas(cv::Mat rgba, FCanvasInfo tiles) {
        if (rgba.empty()) return;

        // Сборщик не ждёт NPU: полотно либо встаёт в очередь, либо теряется
        {
            std::lock_guard<std::mutex> lk(m_infer_mutex);
            if (static_cast<int>(m_infer_queue.size()) >= m_depth) {
                m_dropped.fetch_add(1);
                return;
            }
            m_infer_queue.push_back({ ++m_infer_seq, std::move(rgba), std::move(tiles), std::chrono::steady_clock::now() });
        }
        m_infer_cv.notify_one();
    }

    namespace {
        // Экспоненциальное сглаживание метрик статуса
        void ema(std::atomic<float>& value, float sample) {
            const float old = value.load();
            value.store(old == 0.f ? sample : old * 0.9f + sample * 0.1f);
        }

        bool has_area(const FDetection& d) {
            return d.x2_coord > d.x1_coord && d.y2_coord > d.y1_coord;
        }

        // Рамка, вписанная в область тайла; false — рамка целиком за окном
        bool clip_to(const cv::Rect& r, FDetection& d) {
            d.x1_coord = std::clamp(d.x1_coord, r.x, r.x + r.width);
            d.x2_coord = std::clamp(d.x2_coord, r.x, r.x + r.width);
            d.y1_coord = std::clamp(d.y1_coord, r.y, r.y + r.height);
            d.y2_coord = std::clamp(d.y2_coord, r.y, r.y + r.height);
            return has_area(d);
        }
    }

    void USlot::infer_worker() {
        while (true) {
            FInferJob job;
            {
                std::unique_lock<std::mutex> lk(m_infer_mutex);
                m_infer_cv.wait(lk, [this] { return !m_infer_queue.empty() || !m_infer_running.load(); });
                if (!m_infer_running.load()) break;
                job = std::move(m_infer_queue.front());
                m_infer_queue.pop_front();
            }

            const auto started = std::chrono::steady_clock::now();
            ema(m_wait_ms, std::chrono::duration<float, std::milli>(started - job.enqueued).count());

            FInferred inferred;
            inferred.rgb = job.rgb;
            inferred.tiles = std::move(job.tiles);
            inferred.result = m_classifier->classify(job.rgb, inferred.mask);

            ema(m_infer_ms, std::chrono::duration<float, std::milli>(std::chrono::steady_clock::now() - started).count());
            ema(m_det_count, static_cast<float>(inferred.result.detections.size()));
            deliver(job.seq, std::move(inferred));
        }
    }

    void USlot::deliver(std::int64_t seq, FInferred inferred) {
        std::lock_guard<std::mutex> lk(m_deliver_mutex);
        m_pending.emplace(seq, std::move(inferred));

        // Отдаём подряд всё, что уже досчиталось; дыра в номерах ждёт свой кадр
        while (!m_pending.empty() && m_pending.begin()->first == m_next_seq) {
            auto& ready = m_pending.begin()->second;
            process_inferred(ready.rgb, ready);
            m_pending.erase(m_pending.begin());
            ++m_next_seq;

            ++m_fps_count;
            const auto now = std::chrono::steady_clock::now();
            const float elapsed = std::chrono::duration<float>(now - m_fps_window).count();
            if (elapsed >= 1.f) {
                m_fps.store(m_fps_count / elapsed);
                m_fps_count = 0;
                m_fps_window = now;
            }
        }
    }

    void USlot::process_inferred(cv::Mat rgb_pixels, FInferred& inferred) {
        auto& result = inferred.result;
        auto& mask = inferred.mask;
        static const std::vector<FTilePlacement> no_tiles;
        const auto& tiles = inferred.tiles ? *inferred.tiles : no_tiles;

        // Рамка полотна принадлежит тайлу по центру и переводится в кадр своей камеры
        std::map<std::string, std::vector<FDetection>> by_camera;
        std::map<std::string, cv::Size> resolution;
        std::map<std::string, int> tile_count;
        for (const auto& t : tiles) {
            if (t.state != ETileState::OK) continue;
            ++tile_count[t.camera];
            resolution[t.camera] = cv::Size(t.cam_w, t.cam_h);
            by_camera[t.camera];
        }
        for (const auto& d : result.detections) {
            const int i = tile_of(tiles, d);
            if (i < 0) continue;
            FDetection cam = to_camera(tiles[i], d);
            if (has_area(cam)) by_camera[tiles[i].camera].push_back(std::move(cam));
        }

        int total_tracks = 0;
        for (auto& [camera, dets] : by_camera) {
            // Одна камера в нескольких тайлах даёт дубли в зоне перекрытия
            if (tile_count[camera] > 1) dets = apply_nms(dets, m_config.thresholds.nms);
            const cv::Size& size = resolution[camera];

            auto& tracker = m_trackers[camera];
            if (tracker) {
                auto update_result = tracker->update(dets, size.width, size.height);
                if (update_result.has_events()) {
                    log_events(update_result.events);

                    if ((m_journal.enabled() || m_gateway_sender) && m_composer) {
                        auto task = make_frame_task(camera, size, *tracker, update_result.events);
                        m_composer->request_snapshot(camera, [this, task = std::move(task)](cv::Mat shot) mutable {
                            if (shot.empty()) {
                                journal_row(task, std::string());
                                return;
                            }
                            task.rgb = std::move(shot);
                            task.width = task.rgb.cols;
                            task.height = task.rgb.rows;
                            enqueue_frame(std::move(task));
                        });
                    }
                }

                send_tracks(camera, tracker->tracks(), size);
                total_tracks += static_cast<int>(tracker->tracks().size());
            }
            else {
                send_detections(camera, dets, size);
            }
        }
        m_track_count.store(total_tracks);

        if (m_streaming_enabled) {
            std::vector<FDetection> draw_dets;

            const bool with_tracker = !m_trackers.empty() && m_trackers.begin()->second;
            if (with_tracker) {
                // Треки живут в кадре камеры и рисуются в каждом её тайле
                for (const auto& t : tiles) {
                    if (t.state != ETileState::OK) continue;
                    auto it = m_trackers.find(t.camera);
                    if (it == m_trackers.end() || !it->second) continue;
                    for (const auto& tr : it->second->tracks()) {
                        if (tr.state != ETrackState::CONFIRMED && tr.state != ETrackState::LOST) continue;
                        FDetection d = to_canvas(t, tr.detection);
                        if (clip_to(t.dst, d)) draw_dets.push_back(std::move(d));
                    }
                }
            }
            else { draw_dets = std::move(result.detections); }

            draw_detections_grouped(rgb_pixels, draw_dets, mask, m_config.classes, m_config.superclasses);

            std::lock_guard<std::mutex> lk(m_resource_mutex);
            if (ensure_streamer(rgb_pixels.cols, rgb_pixels.rows)) {
                m_streamer->push_frame(std::move(rgb_pixels));
            }
        }
    }

} // namespace neural
} // namespace varan