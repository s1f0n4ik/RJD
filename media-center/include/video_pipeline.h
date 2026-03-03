#include <mutex>
#include <map>
#include <iostream>
#include <string>
#include <functional>
#include <thread>
#include <filesystem>

#include <gst/gst.h>
#include <gst/video/video.h>
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/webrtc/webrtc.h>

#include "webrtc_session.h"
#include "logger.h"
#include "utility/data-structs.h"

using namespace varan::nvr;

class UCameraPipeline {
protected:
	struct FProbeResult {
		std::string codec_name;
		int width = 0;
		int height = 0;

		std::atomic<bool> got_codec{ false };
		std::atomic<bool> got_video_info{ false };

		bool ready() const {
			return got_codec && got_video_info;
		}
	};

	struct FProbeContext {
		GstElement* pipeline;
		GstElement* decoder;
		GstElement* sink;
		FProbeResult* result;
		ULogger* logger;
	};

public:
	UCameraPipeline(
		const FInputPipelineParameters& parameters,
		std::unique_ptr<ULogger> logger,
		std::function<void(std::string)> send_callback
	);
	virtual ~UCameraPipeline();

	virtual bool initialize();

	bool start();

	bool stop();

	virtual bool destroy();

	void stop_restart_thread();

	void restart_async();

	virtual bool create_webrtc_session(const std::string& client_id, std::string& description);

	virtual bool close_webrtc_session(const std::string& client_id, std::string& description);

	virtual bool process_webrtc_session(
		const std::string& client_id,
		const boost::json::object& message,
		const std::string& type,
		std::string& description
	);

	virtual FPipelineData get_pipeline_data() = 0;

	EPipelineStatus get_status();

	virtual EPilelineType get_type() = 0;

protected:
	// Пробный запуск для получения основных данных по камере
	// timeout по секундам
	bool probe_video_stream(int timeout = 5);

	virtual void restart_loop();

protected:
	GstElement* m_pipeline;
	// Словарь веток, которые есть в пайплайне
	// Ключ - название ветки
	std::map<std::string, GstElement*> m_tees;

	std::mutex m_pipeline_mutex;
	// Словарь сессий webrtcbin
	// Ключ - клиент, с которым установлена сессия
	std::map<std::string, std::unique_ptr<UWebRTCSession>> m_webrtc_sessions;

	// параметры самого pipeline
	FInputPipelineParameters m_parameters;
	// параметры каметры
	FProbeResult m_probe;

	std::function<void(std::string)> m_send_callback;

	std::atomic<bool> m_has_initialized{false};
	std::atomic<bool> m_is_destroying{false};

	// Поток для рестарта
	std::thread m_restart_thread;
	std::atomic<bool> m_is_restarting{false};
	int m_restart_attempts{0};
	int m_max_restart_attempts{0}; // 0 = бесконечно
	int m_backoff_ms{1000};        // стартовая задержка 1 сек
	int m_max_backoff_ms{30000};   // максимум 30 сек

	std::unique_ptr<ULogger> m_logger;

private: 
	// Получение капса из декодера
	static GstPadProbeReturn on_decoder_caps(GstPad*, GstPadProbeInfo* info, gpointer user_data);

	// Поулчение Энкодера и динамическое добавление parse и depay 
	static void on_rtsp_pad_added(GstElement*, GstPad* pad, gpointer user_data);

	// Извлечение caps
	static const GstStructure* extract_caps_structure(GstPadProbeInfo* info, ULogger* logger);
};

class UCameraMainPipeline : public UCameraPipeline {

	struct FRecordBranch {
		GstElement* queue;
		GstElement* parse;
		GstElement* splitmux;

		GstPad* tee_pad;

		bool is_deployed;
	};

public:
	using UCameraPipeline::UCameraPipeline;

	virtual bool initialize() override;

	virtual bool destroy() override;

	virtual bool create_webrtc_session(const std::string& client_id, std::string& description) override;

	virtual FPipelineData get_pipeline_data() override;

	virtual EPilelineType get_type() override;

private:

	bool create_record_branch(GstElement* tee);

	bool destroy_record_branch();

private:

	FRecordBranch m_record_branch;

	std::mutex m_branch_mutex;
};

class UCameraSubPipeline : public UCameraPipeline {
public:
	using UCameraPipeline::UCameraPipeline;

	virtual bool initialize() override;

	virtual bool create_webrtc_session(const std::string& client_id, std::string& description) override;

	virtual FPipelineData get_pipeline_data() override;

	virtual EPilelineType get_type() override;
};