#pragma once

#include "camera.h"
#include "correction-pipeline.h"
#include "utility/frame-storage.h"

namespace varan {
namespace neural {

	/*
		Камера birdview. Помимо обычных потоков умеет поток коррекции дисторсии:
		по WS-сообщению {type:"correction", meta:{enable:true}} валидирует
		сопоставление с калибровкой и поднимает UCorrectionPipeline; клиент после
		успеха переподключается с {type:"connection", correction:true} и его
		сессия уходит на коррекционный поток. Пайплайн умирает вместе с последней
		своей сессией. Основные потоки (запись, кадры в storage) не затрагиваются.
	*/
	class UBirdviewCamera : public UCamera {
	public:
		explicit UBirdviewCamera(
			const std::string& name,
			const FWebSocketOptions& socket_options,
			FFrameStorage<IFrame>* storage,
			ULogger::ELoggerLevel level_ = ULogger::ELoggerLevel::DEBUG
		);

		~UBirdviewCamera() override;

		virtual void set_configurations(
			const FCameraData& options,
			const std::map<std::string, FPipelineConfig>& streams_config,
			CFrameMover dmabuf_callback,
			birdview::UEGLContextManager* gl_manager
		) override;

	protected:

		virtual bool handle_module_message(
			const std::string& client_id,
			const std::string& type,
			const boost::json::object& message
		) override;

		virtual UCameraPipeline* select_web_stream(
			const std::string& client_id,
			const std::string& type,
			const boost::json::object& message
		) override;

		virtual void on_session_closed(const std::string& client_id, UCameraPipeline* stream) override;

	private:

		bool build_correction_pipeline(std::string& error);

		// Разбор пайплайна уходит в поток GMainLoop; wait — дождаться конца
		void destroy_correction(bool wait);

	private:
		FFrameStorage<IFrame>* m_storage = nullptr;
		birdview::UEGLContextManager* m_gl_manager = nullptr;

		std::unique_ptr<UCorrectionPipeline> m_correction;
		std::mutex m_correction_mutex;

		std::atomic<bool> m_correction_building{ false };
		std::thread m_correction_thread;
	};

} // neural
} // varan
