#include <mutex>
#include <map>
#include <iostream>
#include <string>
#include <functional>

#include <gst/gst.h>
#include <gst/video/video.h>
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/webrtc/webrtc.h>

#include "webrtc_session.h"
#include "logger.h"

enum class EPipelineStatus {
	NONE = 0,
	READY = 1,
	STOPPED = 2,
	PLAYING = 3
};

struct FPipelineParameters {
	std::string name = "unnamed";
	std::string rtsp_url = ""; // полная ссылка с пользователем и паролем
	int latency = 200; // в милисекундах
	bool use_udp = false;
	int reconnect_delay = 10; // в секундах

	std::string record_path = ""; // Путь для записи фрагментов
	int segment_length = 600; // Длительность сегмента в секундах

	std::string camera_name = "";
	ULogger::ELoggerLevel debug_level = ULogger::ELoggerLevel::ERROR;

	std::function<void(std::string)> send_callback;
};

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
	UCameraPipeline(const FPipelineParameters& parameters);
	virtual ~UCameraPipeline();

	virtual bool initialize();

	bool start();

	bool stop();

	bool destroy();

	virtual bool create_webrtc_session(const std::string& client_id, std::string& description);

	virtual bool close_webrtc_session(const std::string& client_id, std::string& description);

	EPipelineStatus get_status();

protected:
	// Пробный запуск для получения основных данных по камере
	// timeout по секундам
	bool probe_video_stream(int timeout = 5);

protected:
	GstElement* m_pipeline;
	// Словарь веток, которые есть в пайплайне
	// Ключ - название ветки
	std::map<std::string, GstElement*> m_tees;

	std::mutex m_branch_mutex;
	std::mutex m_pipeline_mutex;
	// Словарь сессий webrtcbin
	// Ключ - клиент, с которым установлена сессия
	std::map<std::string, std::unique_ptr<UWebRTCSession>> m_webrtc_sessions;

	// параметры самого pipeline
	FPipelineParameters m_parameters;
	// параметры каметры
	FProbeResult m_probe;

	bool is_initialized{false};

	ULogger m_logger;

private: 
	// Получение капса из декодера
	static GstPadProbeReturn on_decoder_caps(GstPad*, GstPadProbeInfo* info, gpointer user_data);

	// Поулчение Энкодера и динамическое добавление parse и depay 
	static void on_rtsp_pad_added(GstElement*, GstPad* pad, gpointer user_data);

	// Извлечение caps
	static const GstStructure* extract_caps_structure(GstPadProbeInfo* info, ULogger* logger);
};

class UCameraMainPipeline : UCameraPipeline {
public:
	using UCameraPipeline::UCameraPipeline;

	virtual bool initialize() override;

	virtual bool create_webrtc_session(const std::string& client_id, std::string& description) override;
};

class UCameraSubPipeline : UCameraPipeline {
public:
	using UCameraPipeline::UCameraPipeline;

	virtual bool initialize() override;

	virtual bool create_webrtc_session(const std::string& client_id, std::string& description) override;
};