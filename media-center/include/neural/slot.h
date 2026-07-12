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
#include "neural/gateway-frame.h"

#include <atomic>
#include <cstdint>

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
            FGatewayFrameSender gateway_sender = {},
            FGatewayTimeProvider time_provider = {},
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
        FGatewayDetection make_gateway_detection(int class_id, double confidence, const FDetection& box) const;
        std::vector<FGatewayDetection> gateway_dets_from_detections(const std::vector<FDetection>& dets) const;
        std::vector<FGatewayDetection> gateway_dets_from_tracks(const std::vector<FTrack>& tracks) const;
        void send_to_gateway(std::vector<FGatewayDetection> dets, const cv::Mat& rgb_pixels);

        // Отрисовка на кадре, уходящем в message-gateway: бокс + название класса
        // (кириллица через m_text_renderer) и время/GPS в левом верхнем углу.
        void draw_gateway_overlay(cv::Mat& frame_bgr, const std::vector<FGatewayDetection>& dets,
            const FGatewayTimeGps& time_gps);

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
        FGatewayFrameSender m_gateway_sender;
        // Синхронизированное время+GPS от загрузчика (см. FGatewayTimeProvider).
        // Пустой — если шлюз не сконфигурирован, тогда используются локальные часы.
        FGatewayTimeProvider m_time_provider;
        std::unique_ptr<UTextRenderer> m_text_renderer;
        std::string m_camera_id;
        std::atomic<std::int64_t> m_frame_seq{ 0 };

        // FIX: мьютекс защищает m_classifier и m_streamer от гонки
        // между internal_handle_image() (рабочий поток) и stop() (внешний поток).
        mutable std::mutex m_resource_mutex;

        std::unique_ptr<Classifier> m_classifier;
        std::unique_ptr<UVirtualCamera> m_streamer;

        std::shared_ptr<IDetectionTracker> m_tracker;
    };

} // namespace neural
} // namespace varan