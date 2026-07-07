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
            ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG
        );

        ~USlot() override;

        bool start();
        void stop();

        const std::string& config_id() const { return m_config.id; }
        const std::string& stream_id() const { return m_stream_id; }
        const FCameraMatrix& cameras() const { return m_cameras; }
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

    private:
        FConfigInfo m_config;
        FCameraMatrix m_cameras;
        std::vector<int> m_npu_cores;
        std::string m_stream_id;

        FCameraMessageSender m_sender;

        // FIX: мьютекс защищает m_classifier и m_streamer от гонки
        // между internal_handle_image() (рабочий поток) и stop() (внешний поток).
        mutable std::mutex m_resource_mutex;

        std::unique_ptr<Classifier> m_classifier;
        std::unique_ptr<UVirtualCamera> m_streamer;

        std::shared_ptr<IDetectionTracker> m_tracker;
    };

} // namespace neural
} // namespace varan