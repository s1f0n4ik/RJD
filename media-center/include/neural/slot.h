#pragma once

#include <functional>
#include <opencv2/opencv.hpp>
#include <memory>
#include <mutex>
#include <string>

#include "core/image-handler.h"
#include "bird-view/egl-context.h"
#include "utility/frame-storage.h"

#include "neural/classifier.h"
#include "neural/matrix.h"
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

    class USlot : public UImageHandler {
    public:
        USlot(
            const FConfigInfo& config,
            const FNeuralCoreConfig& core_config,
            birdview::UEGLContextManager* context,
            FFrameStorage<IFrame>* storage,
            FCameraMessageSender sender,
            gateway::FGatewayFrameSender gateway_sender = {},
            gateway::FGatewayTimeProvider time_provider = {},
            journal::FSlotJournal journal = {},
            ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
        );

        ~USlot() override;

        // false — причина в error_code()/error(); слот остаётся остановленным
        bool start();
        void stop();

        const std::string& config_id() const { return m_config.id; }
        const std::string& stream_id() const { return m_stream_id; }
        const std::string& stream_name() const { return m_stream_name; }

        // Размер кадра в эфире. Известен только после первого кадра: слот
        // создаёт вывод под тот размер, что пришёл. Нули — вывода ещё не было
        int stream_width() const { return m_stream_width.load(); }
        int stream_height() const { return m_stream_height.load(); }

        const FCameraMatrix& cameras() const { return m_cameras; }
        const FCameraLayout& layout() const { return m_layout; }

        int depth() const { return m_depth; }
        int depth_actual() const;
        // Потолок кадров в секунду, с которым поток захвата кормит слот
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

    protected:
        void internal_handle_image(cv::Mat rgb_pixels) override;

    private:
        bool ensure_classifier();
        bool ensure_streamer(int width, int height);
        void set_error(int code, const std::string& message);

        // Кадр, ждущий свободного контекста
        struct FInferJob {
            std::int64_t seq = 0;
            cv::Mat rgb;
            std::chrono::steady_clock::time_point enqueued;
        };
        // Кадр после инференса, ждёт своей очереди на доставку
        struct FInferred {
            cv::Mat rgb;
            yolo_inference_result_t result;
            std::vector<uint8_t> mask;
        };

        void infer_worker();
        // Кладёт результат в буфер и доставляет всё, что идёт по порядку
        void deliver(std::int64_t seq, FInferred inferred);
        // Трекер, отправка, эфир — то, что раньше шло сразу за classify()
        void process_inferred(cv::Mat rgb_pixels, FInferred& inferred);

        // Метод для отправки чистых детекций
        void send_detections(const std::vector<FDetection>& detections, const cv::Size& resolution);

        // Метод для отправки треков
        void send_tracks(const std::vector<FTrack>& tracks, const cv::Size& resolution);

        void log_events(const std::vector<FTrackEventRecord>& events);

        // Отправка кадра (детекции + изображение + id камеры) в message-gateway
        // по протоколу. Формирование FGatewayDetection из детекций/треков.
        gateway::FGatewayDetection make_gateway_detection(int class_id, double confidence, const FDetection& box) const;
        std::vector<gateway::FGatewayDetection> gateway_dets_from_detections(const std::vector<FDetection>& dets) const;
        std::vector<gateway::FGatewayDetection> gateway_dets_from_tracks(const std::vector<FTrack>& tracks) const;

        // Задача фонового воркера кадров. cv::Mat здесь — refcount-копия, пиксели
        // не копируются, поэтому постановка в очередь дешёвая. Пустой rgb —
        // кадр потерян при переполнении, запись всё равно уйдёт (без картинки).
        struct FFrameTask {
            cv::Mat rgb;
            int width = 0;
            int height = 0;
            std::int64_t seq = 0;
            gateway::FGatewayTimeGps time_gps;
            // Для шлюза: подтверждённые и недавно потерянные (как требует протокол).
            std::vector<gateway::FGatewayDetection> gw_dets;
            // Для журнала: ВСЕ треки кадра со своим состоянием.
            std::vector<journal::FDetectionObject> objects;
            std::string events;  // типы сработавших событий через запятую
        };

        // Сбор задачи на потоке инференса (без кодирования — только метаданные).
        FFrameTask make_frame_task(const cv::Mat& rgb_pixels,
            const std::vector<FTrackEventRecord>& events);
        // Постановка в очередь. При переполнении теряется картинка самой старой
        // задачи, но её строка в журнал всё равно пишется.
        void enqueue_frame(FFrameTask task);
        void frame_worker();
        // Кодирование обоих кадров: чистого для журнала и аннотированного для шлюза.
        void process_frame_task(const FFrameTask& task);
        // Отдать метаданные журналу. image_path пуст — кадр потерян.
        void journal_row(const FFrameTask& task, const std::string& image_path);

        // Отрисовка на кадре, уходящем в message-gateway: бокс + название класса
        // (кириллица через m_text_renderer) и время/GPS в левом верхнем углу.
        void draw_gateway_overlay(cv::Mat& frame_bgr, const std::vector<gateway::FGatewayDetection>& dets,
            const gateway::FGatewayTimeGps& time_gps);

    private:
        FConfigInfo m_config;
        FCameraMatrix m_cameras;
        FCameraLayout m_layout;
        int m_depth = 1;
        int m_fps_limit = 10;

        // Стриминг аннотированного видео через виртуальную камеру.
        // Включается, если у дескриптора задан streaming.
        std::string m_stream_id;
        std::string m_stream_name;
        std::string m_stream_ip;
        std::string m_stream_port;
        bool m_streaming_enabled = false;

        std::atomic<int> m_stream_width{ 0 };
        std::atomic<int> m_stream_height{ 0 };

        FCameraMessageSender m_sender;

        // Отправка кадров в message-gateway (по протоколу РСМ-2000). Пустой —
        // если шлюз не сконфигурирован.
        gateway::FGatewayFrameSender m_gateway_sender;
        // Синхронизированное время+GPS от загрузчика (см. FGatewayTimeProvider).
        // Пустой — если шлюз не сконфигурирован, тогда используются локальные часы.
        gateway::FGatewayTimeProvider m_time_provider;

        // Ручка журнала обнаружений: корень для JPEG-кадров + sink метаданных.
        // Пустой sink — журналирование выключено (шлюз/журнал не настроены).
        journal::FSlotJournal m_journal;

        std::unique_ptr<UTextRenderer> m_text_renderer;
        std::string m_camera_id;
        std::atomic<std::int64_t> m_frame_seq{ 0 };

        // Мьютекс защищает m_classifier и m_streamer от гонки
        // между рабочими потоками и stop() (внешний поток).
        mutable std::mutex m_resource_mutex;

        std::unique_ptr<Classifier> m_classifier;
        std::unique_ptr<UVirtualCamera> m_streamer;

        std::shared_ptr<IDetectionTracker> m_tracker;

        // Очередь на инференс глубиной m_depth и её рабочие потоки. Поток захвата
        // только кладёт кадр; полная очередь — кадр отброшен.
        std::deque<FInferJob> m_infer_queue;
        std::mutex m_infer_mutex;
        std::condition_variable m_infer_cv;
        std::vector<std::thread> m_infer_threads;
        std::atomic<bool> m_infer_running{ false };
        std::int64_t m_infer_seq = 0;

        // Результаты приходят вразнобой, трекер получает их по seq
        std::map<std::int64_t, FInferred> m_pending;
        std::int64_t m_next_seq = 1;
        std::mutex m_deliver_mutex;
        // fps считается по окну в секунду: буфер переупорядочивания отдаёт кадры пачками
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

        // Фоновый воркер кадров: снимает с потока инференса кодирование JPEG,
        // запись файла журнала и отправку в шлюз. Глубина очереди ограничена —
        // кадры тяжёлые (полноразмерные буферы), поэтому память под контролем.
        std::deque<FFrameTask> m_frame_queue;
        std::mutex m_frame_mutex;
        std::condition_variable m_frame_cv;
        std::thread m_frame_thread;
        std::atomic<bool> m_frame_running{ false };
        static constexpr std::size_t kFrameQueue = 16;
    };

} // namespace neural
} // namespace varan
