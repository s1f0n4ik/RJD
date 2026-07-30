#pragma once

#include "video_pipeline.h"
#include "core/image-handler.h"
#include "utility/frame-storage.h"

// Поток коррекции дисторсии birdview-камеры: кадры из storage прогоняются
// через undist-шейдер и уходят в энкодер. Записи нет, живёт пока есть зрители.
class UCorrectionPipeline : public UNV12EncodingPipeline {
public:
	UCorrectionPipeline(
		const FPipelineConfig& parameters,
		std::unique_ptr<ULogger> logger,
		std::function<void(std::string)> send_callback,
		varan::birdview::UEGLContextManager* gl_manager,
		FFrameStorage<varan::IFrame>* storage
	);

	~UCorrectionPipeline() override;

	// Карты и размер потока задаются до initialize(); карты обязаны совпасть с размером
	bool set_maps(cv::Mat map_x, cv::Mat map_y, int width, int height, int fps, std::string& error);

	virtual bool start() override;

	virtual bool teardown_prefix() override;

	virtual FPipelineData get_pipeline_data() override;

	virtual EPilelineType get_type() override;

private:
	// Источник кадров: EGL-поток с ремапом, результат уходит в push_frame владельца
	class USource : public varan::UImageHandler {
	public:
		USource(
			UCorrectionPipeline* owner,
			varan::birdview::UEGLContextManager* context,
			FFrameStorage<varan::IFrame>* storage
		);

		void set_maps(cv::Mat map_x, cv::Mat map_y);

	protected:
		virtual bool init_converter(varan::UImageConverter& render) override;

		virtual void internal_handle_image(cv::Mat rgb_pixels) override;

	private:
		UCorrectionPipeline* m_owner;
		cv::Mat m_map_x;
		cv::Mat m_map_y;
	};

	void stop_source();

private:
	std::unique_ptr<USource> m_source;
	int m_source_fps = 15;
};
