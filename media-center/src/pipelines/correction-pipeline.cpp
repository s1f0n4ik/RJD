#include "correction-pipeline.h"

UCorrectionPipeline::UCorrectionPipeline(
	const FPipelineConfig& parameters,
	std::unique_ptr<ULogger> logger,
	std::function<void(std::string)> send_callback,
	varan::birdview::UEGLContextManager* gl_manager,
	FFrameStorage<varan::IFrame>* storage
)
	: UNV12EncodingPipeline(parameters, std::move(logger), std::move(send_callback))
{
	m_source = std::make_unique<USource>(this, gl_manager, storage);
}

UCorrectionPipeline::~UCorrectionPipeline() {
	// Источник гасится до разбора базового пайплайна: он пишет в appsrc
	stop_source();
}

bool UCorrectionPipeline::set_maps(cv::Mat map_x, cv::Mat map_y, int width, int height, int fps, std::string& error) {
	if (map_x.empty() || map_y.empty()) {
		error = "Undistortion maps are empty";
		return false;
	}

	if (map_x.cols != width || map_x.rows != height || map_y.cols != width || map_y.rows != height) {
		error = "Undistortion maps size " + std::to_string(map_x.cols) + "x" + std::to_string(map_x.rows)
			+ " does not match stream size " + std::to_string(width) + "x" + std::to_string(height);
		return false;
	}

	m_source_fps = fps;
	m_source->set_maps(std::move(map_x), std::move(map_y));
	set_stream_size(width, height, fps);
	return true;
}

bool UCorrectionPipeline::start() {
	if (!UCameraPipeline::start()) {
		return false;
	}

	if (m_source && !m_source->is_running()) {
		if (!m_source->start_handler_thread(m_parameters.camera_name, m_source_fps)) {
			if (m_logger) m_logger->error("start(): cannot start correction source thread");
			return false;
		}
	}

	return true;
}

bool UCorrectionPipeline::teardown_prefix() {
	stop_source();
	return UNV12EncodingPipeline::teardown_prefix();
}

void UCorrectionPipeline::stop_source() {
	if (m_source && m_source->is_running()) {
		m_source->stop_handler_thread();
	}
}

FPipelineData UCorrectionPipeline::get_pipeline_data() {
	auto data = UNV12EncodingPipeline::get_pipeline_data();
	data.type = EPilelineType::CORRECTION;
	return data;
}

EPilelineType UCorrectionPipeline::get_type() {
	return EPilelineType::CORRECTION;
}

// ─── USource ────────────────────────────────────────────────

UCorrectionPipeline::USource::USource(
	UCorrectionPipeline* owner,
	varan::birdview::UEGLContextManager* context,
	FFrameStorage<varan::IFrame>* storage
)
	: varan::UImageHandler(context, storage, ULogger::ELoggerLevel::DEBUG, "Correction " + owner->m_parameters.camera_name)
	, m_owner(owner)
{}

void UCorrectionPipeline::USource::set_maps(cv::Mat map_x, cv::Mat map_y) {
	m_map_x = std::move(map_x);
	m_map_y = std::move(map_y);
}

bool UCorrectionPipeline::USource::init_converter(varan::UImageConverter& render) {
	if (!render.init(&m_logger, true)) {
		return false;
	}
	return render.set_maps(m_map_x, m_map_y, &m_logger);
}

void UCorrectionPipeline::USource::internal_handle_image(cv::Mat rgb_pixels) {
	m_owner->push_frame(std::move(rgb_pixels));
}
