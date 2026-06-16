#pragma once

#include <functional>
#include <opencv2/opencv.hpp>
#include <memory>
#include <string>

#include "core/image-handler.h"
#include "bird-view/egl-context.h"
#include "utility/frame-storage.h"

#include "neural/classifier.h"
#include "neural/matrix.h"
#include "neural/utility.h"

#include "logger.h"
#include "camera.h"

namespace varan {
    namespace neural {

        // Функция отправки сообщений клиентам конкретной камеры.
        // Живёт ровно столько, сколько живёт USlot.
        using FCameraMessageSender = std::function<void(const std::string& message)>;

        class USlot : public UImageHandler {
        public:
            USlot(
                const FConfigInfo& config,
                const FCameraMatrix& cameras,
                const std::vector<int>& npu_cores,
                const std::string& stream_id,
                const std::string& ip,
                const std::string& port,
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

            // Сериализует детекции и отправляет через m_sender
            void send_detections(const std::vector<FDetection>& detections, const cv::Size& resolution);

        private:
            FConfigInfo m_config;
            FCameraMatrix m_cameras;
            std::vector<int> m_npu_cores;
            std::string m_stream_id;
            std::string m_ip;
            std::string m_port;

            FCameraMessageSender m_sender;

            std::unique_ptr<Classifier> m_classifier;
            std::unique_ptr<UVirtualCamera> m_streamer;
        };

    } // namespace neural
} // namespace varan