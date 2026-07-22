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
#include <cstdint>
#include <deque>
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

        bool start();
        void stop();

        const std::string& config_id() const { return m_config.id; }
        const std::string& stream_id() const { return m_stream_id; }
        const FCameraMatrix& cameras() const { return m_cameras; }
        const FCameraLayout& layout() const { return m_layout; }
        const std::vector<int>& cores() const { return m_npu_cores; }

    protected:
        void internal_handle_image(cv::Mat rgb_pixels) override;

    private:
        bool ensure_classifier();
        bool ensure_streamer(int width, int height);

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
        std::vector<int> m_npu_cores;

        // Стриминг аннотированного видео через виртуальную камеру.
        // Включается, если у дескриптора задан streaming.
        std::string m_stream_id;
        std::string m_stream_name;
        std::string m_stream_ip;
        std::string m_stream_port;
        bool m_streaming_enabled = false;

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

        // FIX: мьютекс защищает m_classifier и m_streamer от гонки
        // между internal_handle_image() (рабочий поток) и stop() (внешний поток).
        mutable std::mutex m_resource_mutex;

        std::unique_ptr<Classifier> m_classifier;
        std::unique_ptr<UVirtualCamera> m_streamer;

        std::shared_ptr<IDetectionTracker> m_tracker;

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