#include "camera.h"

namespace varan {
namespace neural {

    UVirtualCamera::UVirtualCamera(
        const std::string& id,
        const FWebSocketOptions& socket_options,
        ULogger::ELoggerLevel level_
    )
        : UCamera(id, socket_options, level_)
    {
        std::string pipeline_name = "nv12_encoder";
        auto config = FPipelineConfig{ pipeline_name, id, "", 0, EPilelineType::NV12_ENCODER, 0, false, 10, "", 10};

        m_options.id = id;
        m_options.type = ECameraType::VIRTUAL;

        auto pipe_logger = std::make_unique<ULogger>(id + ": " + pipeline_name, m_logger.get_level());
        auto send_callback = [this](std::string msg) {this->send_message(std::move(msg)); };

        m_streams[pipeline_name] = create_pipeline(pipeline_name, config, "", std::move(pipe_logger), send_callback, nullptr, nullptr);
    }

    std::unique_ptr<UCameraPipeline> UVirtualCamera::create_pipeline(
        const std::string& name,
        const FPipelineConfig& stream_data,
        const std::string& rtsp_url,
        std::unique_ptr<ULogger> logger,
        std::function<void(std::string)> send_callback,
        CFrameMover frame_callback,
        birdview::UEGLContextManager* gl_manager
    ) {
        if (stream_data.type != EPilelineType::NV12_ENCODER) {
            throw std::runtime_error("UVirtualCamera supports only NV12 pipeline");
        }

        auto pipeline = std::make_unique<UNV12EncodingPipeline>(
            stream_data,
            std::move(logger),
            std::move(send_callback)
        );

        m_nv12_pipeline = pipeline.get();

        return pipeline;
    }

    void UVirtualCamera::set_configurations(
        const FCameraData& options,
        const std::map<std::string, FPipelineConfig>& streams_config,
        CFrameMover dmabuf_callback,
        birdview::UEGLContextManager* m_gl_manager
    ) {
        m_logger.warn("set_configurations doesn't available at virtual camera");
    }

    bool UVirtualCamera::set_parameters(int width, int height, int fps) {
        if (m_nv12_pipeline) {
            m_nv12_pipeline->set_stream_size(width, height, fps);
            return true;
        }
        else {
            return false;
        }
    }

    void UVirtualCamera::push_frame(cv::Mat frame) {
        if (m_nv12_pipeline) {
            m_nv12_pipeline->push_frame(std::move(frame));
            return;
        }
    }

    std::optional<cv::Mat> UVirtualCamera::get_cached_frame() {
        if (m_nv12_pipeline) {
            return m_nv12_pipeline->get_cached_frame();
        }
        else {
            m_logger.trace("Cannot get cached frame from virtual camera " + m_name + ": null encoder pipeline!");
            return std::nullopt;
        }
    }

} // neural
} // varan