#pragma once

#include <functional>
#include <opencv2/opencv.hpp>
#include <memory>
#include <mutex>
#include <string>

#include "bird-view/egl-context.h"
#include "utility/frame-storage.h"

#include "neural/classifier.h"
#include "neural/canvas-composer.h"
#include "neural/video-stream.h"
#include "neural/utility.h"
#include "neural/tracker/tracker-interface.h"
#include "gateway/frame.h"
#include "journal/types.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <map>
#include <thread>
#include <condition_variable>
#include <vector>

#include "logger.h"
#include "camera.h"

namespace varan {
namespace neural {

    using FCameraMessageSender = std::function<void(const std::string& message)>;
    using FCameraSenderProvider = std::function<FCameraMessageSender(const std::string& camera_id)>;

    class USlot {
    public:
        USlot(
            const FConfigInfo& config,
            const FNeuralCoreConfig& core_config,
            const FVideoStream& video,
            birdview::UEGLContextManager* context,
            FFrameStorage<IFrame>* storage,
            FCameraSenderProvider sender_provider,
            gateway::FGatewayFrameSender gateway_sender = {},
            gateway::FGatewayTimeProvider time_provider = {},
            journal::FSlotJournal journal = {},
            ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
        );

        ~USlot();

        // false — причина в error_code()/error(); слот остаётся остановленным
        bool start();
        void stop();
        bool is_running() const;

        const std::string& config_id() const { return m_config.id; }
        const FVideoStream& video() const { return m_video; }
        const std::string& video_id() const { return m_video.id; }
        // Размещение тайлов последнего тика; пустой — полотно ещё не собиралось
        FCanvasInfo tiles() const;
        int canvas_width() const { return m_canvas_width.load(); }
        int canvas_height() const { return m_canvas_height.load(); }

        const std::string& stream_id() const { return m_stream_id; }
        const std::string& stream_name() const { return m_stream_name; }

        // Размер кадра в эфире; нули — вывода ещё не было
        int stream_width() const { return m_stream_width.load(); }
        int stream_height() const { return m_stream_height.load(); }

        int depth() const { return m_depth; }
        int depth_actual() const;
        // Потолок кадров в секунду, с которым сборщик кормит слот
        int fps_limit() const { return m_fps_limit; }
        std::string model_layout() const;
        // nullptr — модель не загружена
        const FModelInfo* model_info() const;

        // 0 — ошибки нет
        int error_code() const { return m_error_code.load(); }
        std::string error() const;

        float infer_ms() const { return m_infer_ms.load(); }
        float wait_ms() const { return m_wait_ms.load(); }
        float fps() const { return m_fps.load(); }
        // Детекций на кадр после NMS (среднее) и треков сейчас
        float detections() const { return m_det_count.load(); }
        int tracks() const { return m_track_count.load(); }
        std::int64_t dropped() const { return m_dropped.load(); }

    private:
        bool ensure_classifier();
        bool ensure_streamer(int width, int height);
        void set_error(int code, const std::string& message);
        std::shared_ptr<IDetectionTracker> make_tracker() const;
        FCameraMessageSender& sender_for(const std::string& camera);

        // Полотно от сборщика: в очередь инференса или в отброшенные
        void on_canvas(cv::Mat rgba, FCanvasInfo tiles);

        // Кадр, ждущий свободного контекста
        struct FInferJob {
            std::int64_t seq = 0;
            cv::Mat rgb;
            FCanvasInfo tiles;
            std::chrono::steady_clock::time_point enqueued;
        };
        // Кадр после инференса, ждёт своей очереди на доставку
        struct FInferred {
            cv::Mat rgb;
            FCanvasInfo tiles;
            yolo_inference_result_t result;
            std::vector<uint8_t> mask;
        };

        void infer_worker();
        // Кладёт результат в буфер и доставляет всё, что идёт по порядку
        void deliver(std::int64_t seq, FInferred inferred);
        // Разнос детекций по камерам, трекеры, отправка, эфир
        void process_inferred(cv::Mat rgb_pixels, FInferred& inferred);

        void send_detections(const std::string& camera, const std::vector<FDetection>& detections, const cv::Size& resolution);
        void send_tracks(const std::string& camera, const std::vector<FTrack>& tracks, const cv::Size& resolution);

        void log_events(const std::vector<FTrackEventRecord>& events);

        gateway::FGatewayDetection make_gateway_detection(int class_id, double confidence, const FDetection& box) const;
        std::vector<gateway::FGatewayDetection> gateway_dets_from_detections(const std::vector<FDetection>& dets) const;
        std::vector<gateway::FGatewayDetection> gateway_dets_from_tracks(const std::vector<FTrack>& tracks) const;

        // Задача фонового воркера: метаданные собираются при событии, кадр камеры приходит снимком на тик позже
        struct FFrameTask {
            std::string camera;
            cv::Mat rgb;
            int width = 0;
            int height = 0;
            std::int64_t seq = 0;
            gateway::FGatewayTimeGps time_gps;
            // Для шлюза: подтверждённые и недавно потерянные
            std::vector<gateway::FGatewayDetection> gw_dets;
            // Для журнала: все треки кадра со своим состоянием
            std::vector<journal::FDetectionObject> objects;
            std::string events;
        };

        FFrameTask make_frame_task(const std::string& camera, const cv::Size& resolution,
            const IDetectionTracker& tracker, const std::vector<FTrackEventRecord>& events);
        // Постановка в очередь; при переполнении теряется картинка самой старой задачи, строка пишется
        void enqueue_frame(FFrameTask task);
        void frame_worker();
        void process_frame_task(const FFrameTask& task);
        // Отдать метаданные журналу. image_path пуст — кадр потерян
        void journal_row(const FFrameTask& task, const std::string& image_path);

        void draw_gateway_overlay(cv::Mat& frame_bgr, const std::vector<gateway::FGatewayDetection>& dets,
            const gateway::FGatewayTimeGps& time_gps);

    private:
        FConfigInfo m_config;
        FVideoStream m_video;
        int m_depth = 1;
        int m_fps_limit = 10;

        birdview::UEGLContextManager* m_context;
        FFrameStorage<IFrame>* m_storage;
        ULogger::ELoggerLevel m_level;
        ULogger m_logger;

        std::unique_ptr<UCanvasComposer> m_composer;
        std::atomic<int> m_canvas_width{ 0 };
        std::atomic<int> m_canvas_height{ 0 };

        // Стриминг полотна с рамками через виртуальную камеру
        std::string m_stream_id;
        std::string m_stream_name;
        std::string m_stream_ip;
        std::string m_stream_port;
        bool m_streaming_enabled = false;

        std::atomic<int> m_stream_width{ 0 };
        std::atomic<int> m_stream_height{ 0 };

        FCameraSenderProvider m_sender_provider;
        std::map<std::string, FCameraMessageSender> m_senders;
        std::mutex m_senders_mutex;

        gateway::FGatewayFrameSender m_gateway_sender;
        gateway::FGatewayTimeProvider m_time_provider;
        journal::FSlotJournal m_journal;

        std::unique_ptr<UTextRenderer> m_text_renderer;
        std::atomic<std::int64_t> m_frame_seq{ 0 };

        // Мьютекс защищает m_classifier и m_streamer от гонки между рабочими потоками и stop()
        mutable std::mutex m_resource_mutex;

        std::unique_ptr<Classifier> m_classifier;
        std::unique_ptr<UVirtualCamera> m_streamer;

        // Трекер на камеру; доступ только под m_deliver_mutex
        std::map<std::string, std::shared_ptr<IDetectionTracker>> m_trackers;

        std::deque<FInferJob> m_infer_queue;
        std::mutex m_infer_mutex;
        std::condition_variable m_infer_cv;
        std::vector<std::thread> m_infer_threads;
        std::atomic<bool> m_infer_running{ false };
        std::int64_t m_infer_seq = 0;

        std::map<std::int64_t, FInferred> m_pending;
        std::int64_t m_next_seq = 1;
        std::mutex m_deliver_mutex;
        std::chrono::steady_clock::time_point m_fps_window;
        int m_fps_count = 0;

        std::atomic<float> m_infer_ms{ 0.f };
        std::atomic<float> m_wait_ms{ 0.f };
        std::atomic<float> m_fps{ 0.f };
        std::atomic<float> m_det_count{ 0.f };
        std::atomic<int> m_track_count{ 0 };
        std::atomic<std::int64_t> m_dropped{ 0 };

        std::atomic<int> m_error_code{ 0 };
        std::string m_error;
        mutable std::mutex m_error_mutex;

        std::deque<FFrameTask> m_frame_queue;
        std::mutex m_frame_mutex;
        std::condition_variable m_frame_cv;
        std::thread m_frame_thread;
        std::atomic<bool> m_frame_running{ false };
        static constexpr std::size_t kFrameQueue = 16;
    };

} // namespace neural
} // namespace varan
