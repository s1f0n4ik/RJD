#pragma once 

#include <mutex>
#include <condition_variable>
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

#include <gst/gl/gl.h>
#include <gst/gl/gstglcontext.h>
#include <gst/gl/gstgldisplay.h>
#include <gst/gl/egl/gstgldisplay_egl.h>

#include <opencv2/opencv.hpp>

#include "webrtc_session.h"
#include "logger.h"
#include "utility/data-structs.h"
#include "utility/frames.h"
#include "bird-view/egl-context.h"

using namespace varan::nvr;
using namespace varan;

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
		const FPipelineConfig& parameters,
		std::unique_ptr<ULogger> logger,
		std::function<void(std::string)> send_callback
	);
	virtual ~UCameraPipeline();

	virtual bool initialize();

	virtual bool start();

	bool stop();

	bool teardown(bool is_stop = true);

	virtual bool teardown_prefix();

	void request_stop();

	void stop_restart_thread();

	void shedule_restart();

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
	guint m_bus_watch_id = 0;
	// Словарь веток, которые есть в пайплайне
	// Ключ - название ветки
	std::map<std::string, GstElement*> m_tees;

	std::mutex m_pipeline_mutex;
	// Словарь сессий webrtcbin
	// Ключ - клиент, с которым установлена сессия
	std::map<std::string, std::unique_ptr<UWebRTCSession>> m_webrtc_sessions;

	// параметры самого pipeline
	FPipelineConfig m_parameters;
	// параметры каметры
	FProbeResult m_probe;

	std::function<void(std::string)> m_send_callback;

	std::atomic<bool> m_has_initialized{false};
	std::atomic<bool> m_is_playing{false};

	// Поток для рестарта
	std::thread m_restart_thread;
	std::atomic<bool> m_is_restarting{false};
	int m_restart_attempts{0};
	int m_max_restart_attempts{0}; // 0 = бесконечно
	int m_backoff_ms{1000};        // стартовая задержка 1 сек
	int m_max_backoff_ms{30000};   // максимум 30 сек

	std::atomic<bool> m_stop_requested{ false };
	std::mutex        m_restart_cv_mutex;
	std::condition_variable m_restart_cv;

	std::unique_ptr<ULogger> m_logger;

private: 
	// Получение капса из декодера
	static GstPadProbeReturn on_decoder_caps(GstPad*, GstPadProbeInfo* info, gpointer user_data);

	// Поулчение Энкодера и динамическое добавление parse и depay 
	static void on_rtsp_pad_added(GstElement*, GstPad* pad, gpointer user_data);

	// Извлечение caps
	static const GstStructure* extract_caps_structure(GstPadProbeInfo* info, ULogger* logger);
};

struct FGstGLContext {
	EGLDisplay root_display = EGL_NO_DISPLAY;
	varan::birdview::FEGLContext shared_context;
	GstContext* display = nullptr;
	GstContext* app = nullptr;
	bool is_initialized{false};
};

class UCameraMainPipeline : public UCameraPipeline {

	enum class EBranchType { DECODER, RECORD };

	struct FPipelineBranch {
		using elements_map = std::vector<std::pair<std::string, GstElement*>>;
		elements_map elements;

		GstPad* tee_pad = nullptr;
		std::atomic<bool> is_deployed = false;
		EBranchType type;
		std::string name;

		FPipelineBranch(EBranchType t, std::string name_) : type(t), name(name_) {}

		GstElement* get_element(const std::string& name) {
			for (const auto& pair_element : elements) {
				if (pair_element.first == name) {
					return pair_element.second;
				}
			}
			return nullptr;
		}

		void add_element(std::string name, GstElement* element) {
			elements.push_back(std::pair<std::string, GstElement*>(name, element));
		}
	};

public:
	UCameraMainPipeline(
		const FPipelineConfig& parameters,
		std::unique_ptr<ULogger> logger,
		std::function<void(std::string)> send_callback,
		varan::birdview::UEGLContextManager* gl_context_manager = nullptr,
		CFrameMover dma_callback = nullptr
	);

	~UCameraMainPipeline() override;

	virtual bool initialize() override;

	virtual bool teardown_prefix() override;

	virtual bool create_webrtc_session(const std::string& client_id, std::string& description) override;

	virtual FPipelineData get_pipeline_data() override;

	virtual EPilelineType get_type() override;

private:

	void create_gst_gl_context(varan::birdview::UEGLContextManager* gl_context_manager);

	bool create_decoder_branch(GstElement* tee);

	bool create_record_branch(GstElement* tee);

	void set_timer_check_record_branch();

	bool destroy_branch(FPipelineBranch& branch);

	void destroy_gst_gl_context();

	static GstFlowReturn on_new_sample_dma(GstElement* sink, gpointer user_data);

	static GstFlowReturn on_new_sample_gl_texture(GstElement* sink, gpointer user_data);

	static float get_disk_usage(const std::string path, ULogger* logger);

private:

	FGstGLContext m_gl_context;

	FPipelineBranch m_record_branch;
	std::filesystem::path m_record_path = "";

	FPipelineBranch m_decoder_branch;

	CFrameMover m_dma_sender;

	std::mutex m_branch_mutex;
};

class UCameraSubPipeline : public UCameraPipeline {
public:
	using UCameraPipeline::UCameraPipeline;

	~UCameraSubPipeline() override;

	virtual bool initialize() override;

	virtual bool create_webrtc_session(const std::string& client_id, std::string& description) override;

	virtual FPipelineData get_pipeline_data() override;

	virtual EPilelineType get_type() override;
};

class UNV12EncodingPipeline : public UCameraPipeline {
public:
	using UCameraPipeline::UCameraPipeline;

	~UNV12EncodingPipeline() override;

	void push_frame(cv::Mat frame);

	void set_stream_size(int width, int height, int fps);

	std::optional<cv::Mat> get_cached_frame();

	virtual bool initialize() override;

	virtual bool teardown_prefix() override;

	virtual bool create_webrtc_session(const std::string& client_id, std::string& description) override;

	virtual FPipelineData get_pipeline_data() override;

	virtual EPilelineType get_type() override;

private:
	GstElement* m_appsrc;
	std::mutex m_appsrc_mutex;

	guint64 m_frame_count = 0;

	cv::Mat m_cached_frame;
	std::mutex m_cached_mutex;

	int m_width = 800;
	int m_height = 600;
	int m_fps = 15;

	std::atomic<bool> m_is_set{false};
};