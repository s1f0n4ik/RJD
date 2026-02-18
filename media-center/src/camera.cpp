#include "camera.h"
#include <libavutil/hwcontext_drm.h>
#include <gst/gst.h>
#include <gst/allocators/allocators.h>
#include <gst/webrtc/webrtc.h>
#include <ranges>

#include "console_utility.h"
#include "video_utility.h"
#include "signaling_definers.h"

#include <gst/rtsp/gstrtsptransport.h>

namespace varan {
namespace neural {

	std::string get_ffmpeg_error(int ret) {
		char errbuf[256];
		av_strerror(ret, errbuf, sizeof(errbuf));
		return errbuf;
	}

	std::string get_pix_fmts_string(const enum AVPixelFormat* pix_fmts) {
		if (!pix_fmts) return "null";

		std::string result;
		for (int i = 0; pix_fmts[i] != AV_PIX_FMT_NONE; ++i) {
			const char* name = av_get_pix_fmt_name(pix_fmts[i]);
			if (!name) name = "unknown";
			if (!result.empty()) result += ", ";
			result += name;
		}
		return result;
	}

	UCamera::UCamera(const FCameraOptions& options, const FWebSocketOptions& socket_options, ULogger::ELoggerLevel level)
		: m_running(false)
		, m_error(false)
		, m_initialized(false)
		, m_gst_initialized(false)
		, m_frames_buffer(1)
		, m_io_context()
		, m_work_guard(boost::asio::make_work_guard(m_io_context))
		, m_websocket_client(nullptr)
		, m_probe_result()
		, m_socket_options(socket_options)
		, m_options(options)
		, m_logger(options.name, level)
	{
		// Основной пайплайн
		auto main_settings = FPipelineParameters{
			"Main Pipeline", 
			options.main_rtsp_url, options.main_latency, options.b_main_udp, options.reconnect_delay,
			options.record_path, options.segment_duration, 
			options.name, level, 
			[this](std::string msg) {
				this->send_message(std::move(msg));
			}
		};
		m_main = std::make_unique<UCameraMainPipeline>(main_settings);

		// Дополнительный пайплайн
		auto sub_settings = FPipelineParameters{
			"Sub Pipeline",
			options.sub_rtsp_url, options.sub_latency, options.b_sub_udp, options.reconnect_delay,
			"", 0,
			options.name, level,
			[this](std::string msg) {
				this->send_message(std::move(msg));
			}
		};
		m_sub = std::make_unique<UCameraSubPipeline>(sub_settings);
	};

	UCamera::~UCamera() { 
		stop(); 
		stop_websocket_client();
	}

	bool UCamera::initialize() {
		if (m_initialized) return true;

		auto start_g_loop = [&]() {
			m_main_loop = g_main_loop_new(nullptr, FALSE);
			m_gst_loop_thread = std::thread([&]() {
				g_main_loop_run(m_main_loop);
			});
		};

		auto stop_g_loop = [&]() {
			if (m_main_loop) {
				g_main_loop_quit(m_main_loop);
			}
			if (m_gst_loop_thread.joinable()) {
				m_gst_loop_thread.join();
			}
			if (m_main_loop) {
				g_main_loop_unref(m_main_loop);
				m_main_loop = nullptr;
			}
		};

		try {
			start_g_loop();
			
			if (m_main->initialize() == false) {
				m_logger.error("False to initialize main pipeline!");
				stop_g_loop();
				return false;
			}
			if (m_sub->initialize() == false) {
				m_logger.error("False to initialize sub pipeline!");
				stop_g_loop();
				return false;
			}
			m_initialized = true;
			return true;
		}
		catch (const std::runtime_error& error) {
			std::cerr << error.what();
			stop_g_loop();
			return false;
		}
	}

	std::string UCamera::get_name() {
		if (m_initialized) {
			return m_options.name;
		}
		else {
			return "Camera has not inititalized!";
		}
	}

	bool UCamera::start() {
		if (m_running) return true;

		start_websocket_client();

		if (!m_main.get()->start()) {
			m_logger.error("Error start main pipeline!");
			return false;
		}

		if (!m_sub->start()) {
			m_logger.error("Error start sub pipeline!");
			return false;
		}

		m_running = true;
		return true;
	}

	void UCamera::stop() {
		if (!m_running) return;
		m_running = false;

		if (m_gst_loop_thread.joinable()) m_gst_loop_thread.join();
		if (m_main_loop) g_main_loop_quit(m_main_loop);

		stop_websocket_client();
	}

	void UCamera::set_frame_callback(CFrameCallback callback) {
		m_frame_callback = std::move(callback);
	}
	
	// ====================================
	//     GStreaming Camera Probe
	// ====================================

	// Статическая функция, которая срабатывает при получении автокапса
	// Берем значения этого капса
	/*
	GstPadProbeReturn UCamera::on_rtsp_caps_event(GstPad* pad, GstPadProbeInfo* info, gpointer user_data)
	{
		auto* result = static_cast<FProbeResult*>(user_data);

		if (!(info->type & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM)) {
			return GST_PAD_PROBE_OK;
		}

		GstEvent* event = gst_pad_probe_info_get_event(info);
		if (GST_EVENT_TYPE(event) != GST_EVENT_CAPS) {
			return GST_PAD_PROBE_OK;
		}

		GstCaps* caps = nullptr;
		gst_event_parse_caps(event, &caps);
		if (!caps || gst_caps_is_empty(caps)) {
			return GST_PAD_PROBE_OK;
		}

		try {
			gchar* caps_str = gst_caps_to_string(caps);
			g_print("Caps: %s\n", caps_str);
			g_free(caps_str);

			const GstStructure* s = gst_caps_get_structure(caps, 0);

			result->codec_name = gst_structure_get_string(s, "encoding-name");
			result->ready = true;
		}
		catch (...) {
			result->ready = false;
			return GST_PAD_PROBE_DROP;
		}
		return GST_PAD_PROBE_OK;
	}

	GstPadProbeReturn UCamera::on_parse_caps_event(GstPad* pad, GstPadProbeInfo* info, gpointer user_data)
	{
		auto* result = static_cast<FProbeResult*>(user_data);


		if (!(info->type & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM)) {
			return GST_PAD_PROBE_OK;
		}

		GstEvent* event = gst_pad_probe_info_get_event(info);
		if (GST_EVENT_TYPE(event) != GST_EVENT_CAPS) {
			return GST_PAD_PROBE_OK;
		}

		GstCaps* caps = nullptr;
		gst_event_parse_caps(event, &caps);
		if (!caps || gst_caps_is_empty(caps)) {
			return GST_PAD_PROBE_OK;
		}

		gchar* caps_str = gst_caps_to_string(caps);
		g_print("Caps: %s\n", caps_str);
		g_free(caps_str);

		const GstStructure* s = gst_caps_get_structure(caps, 0);

		if (!gst_structure_get_int(s, "width", &result->width) || !gst_structure_get_int(s, "height", &result->height)) {
			result->ready = false;
			return GST_PAD_PROBE_OK;
		}

		result->ready = true;
		return GST_PAD_PROBE_OK;
	}

	void UCamera::on_rtspsrc_pad_added(GstElement* src, GstPad* pad, gpointer user_data)
	{
		auto result = static_cast<FProbeResult*>(user_data);
		GstElement* fakesink = result->sink_element;

		GstPad* sink_pad = gst_element_get_static_pad(fakesink, "sink");
		if (gst_pad_is_linked(sink_pad)) {
			gst_object_unref(sink_pad);
			return;
		}

		gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM, on_rtsp_caps_event, result, nullptr);

		gst_pad_link(pad, sink_pad);
		gst_object_unref(sink_pad);
		result->sink_element = nullptr;
	}

	void UCamera::on_rtspsrc_pad_depay_added(GstElement* src, GstPad* pad, gpointer user_data)
	{
		auto result = static_cast<FProbeResult*>(user_data);
		GstElement* depay = result->depay;

		GstPad* sink_pad = gst_element_get_static_pad(depay, "sink");
		if (gst_pad_is_linked(sink_pad)) {
			gst_object_unref(sink_pad);
			return;
		}

		gst_pad_link(pad, sink_pad);
		gst_object_unref(sink_pad);
	}

	bool UCamera::codec_check_probe(int timeout_sec) {
		m_logger.info("Starting RTSP probe pipeline!");

		TUniqueGst pipeline = TUniqueGst(gst_pipeline_new("probe-pipeline"), &gst_object_unref);
		auto src = gst_element_factory_make("rtspsrc", "src");
		auto sink = gst_element_factory_make("fakesink", "sink");

		auto cleanup = [&]() {
			if (src) gst_object_unref(src);
			if (sink) gst_object_unref(sink);
		};

		if (!pipeline || !src || !sink) {
			std::ostringstream oss;
			oss << "Failed to create elements at probe pipeline: "
				<< "\n\tpipeline=" << (pipeline ? "OK" : "NULL") << ","
				<< "\n\tsrc=" << (src ? "OK" : "NULL") << ","
				<< "\n\tsink=" << (sink ? "OK" : "NULL") << ",";
			m_logger.error(oss.str());
			cleanup();
			return false;
		}

		m_logger.info("Elements at probe pipeline created successfully!");

		g_object_set(src,
			"location", m_options.main_rtsp_url.c_str(),
			"protocols", GST_RTSP_LOWER_TRANS_TCP,
			"latency", 0,
			nullptr
		);

		m_probe_result.sink_element = sink;

		gst_bin_add_many(GST_BIN(pipeline.get()), src, sink, nullptr);

		// Сигнал для получения капса
		g_signal_connect(src, "pad-added", G_CALLBACK(on_rtspsrc_pad_added), &m_probe_result);

		m_logger.debug("Elements added to pipeline");

		// Запус пайплайна
		gst_element_set_state(pipeline.get(), GST_STATE_PLAYING);
		m_logger.debug("Probe pipeline set state playing!");

		TUniqueBus bus = TUniqueBus(gst_element_get_bus(pipeline.get()), &gst_object_unref);
		gint64 deadline = g_get_monotonic_time() + timeout_sec * G_TIME_SPAN_SECOND;

		while (!m_probe_result.ready && g_get_monotonic_time() < deadline) {
			GstMessage* msg = gst_bus_timed_pop(bus.get(), 200 * GST_MSECOND);
			if (!msg) {
				continue;
			}

			if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
				GError* err;
				gchar* dbg;
				gst_message_parse_error(msg, &err, &dbg);

				std::ostringstream oss;

				oss << "GStreamer error from " << GST_OBJECT_NAME(msg->src) << ": "
					<< (err && err->message ? err->message : "unknown error")
					<< (dbg ? std::string(" | debug: ") + dbg : "");
				m_logger.error(oss.str());

				if (err) g_error_free(err);
				if (dbg) g_free(dbg);
				gst_message_unref(msg);

				break;
			}

			gst_message_unref(msg);
		}

		gst_element_set_state(pipeline.get(), GST_STATE_NULL);
		if (m_probe_result.ready) {
			m_probe_result.ready = false;
			return true;
		}
		else {
			return false;
		}
	}

	bool UCamera::camera_probe(int timeout_sec)
	{

		TUniqueGst pipeline = TUniqueGst(gst_pipeline_new("probe-pipeline"), &gst_object_unref);

		std::string depay_str = std::string("H264") == m_probe_result.codec_name ? "rtph264depay" : "rtph265depay";
		std::string parse_str = std::string("H264") == m_probe_result.codec_name ? "h264parse" : "h265parse";

		auto src = gst_element_factory_make("rtspsrc", "src");
		auto depay = gst_element_factory_make(depay_str.c_str(), "depay");
		auto parse = gst_element_factory_make(parse_str.c_str(), "parse");
		auto decoder = gst_element_factory_make("mppvideodec", "decoder");
		auto sink = gst_element_factory_make("fakesink", "sink");

		auto cleanup = [&]() {
			if (src) gst_object_unref(src);
			if (depay) gst_object_unref(depay);
			if (parse) gst_object_unref(parse);
			if (decoder) gst_object_unref(decoder);
			if (sink) gst_object_unref(sink);
		};

		if (!pipeline || !src || !depay || !parse || !sink || !decoder) {
			std::ostringstream oss;
			oss << "Failed to create elements at probe pipeline: "
				<< "\n\tpipeline=" << (pipeline ? "OK" : "NULL") << ","
				<< "\n\tsrc=" << (src ? "OK" : "NULL")
				<< "\n\tdepay=" << (depay ? "OK" : "NULL")
				<< "\n\tparse=" << (parse ? "OK" : "NULL")
				<< "\n\tdecoder=" << (decoder ? "OK" : "NULL")
				<< "\n\tsink=" << (sink ? "OK" : "NULL");
			m_logger.error(oss.str());
			cleanup();
			return false;
		}

		g_object_set(src,
			"location", m_options.main_rtsp_url.c_str(),
			"protocols", GST_RTSP_LOWER_TRANS_TCP,
			"latency", 0,
			nullptr
		);

		g_object_set(parse, "config-interval", -1, nullptr);

		gst_bin_add_many(GST_BIN(pipeline.get()), src, depay, parse, decoder, sink, nullptr);

		if (!gst_element_link_many(depay, parse, decoder, sink, nullptr)) {
			m_logger.error("Failed to link elements at probe pipeline: depay, parse, decoder, sink!");
			return false;
		}

		m_probe_result.depay = depay;
		g_signal_connect(src, "pad-added", G_CALLBACK(on_rtspsrc_pad_depay_added), &m_probe_result);

		auto pad = gst_element_get_static_pad(decoder, "src");

		gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM, on_parse_caps_event, &m_probe_result, nullptr);

		gst_element_set_state(pipeline.get(), GST_STATE_PLAYING);

		TUniqueBus bus = TUniqueBus(gst_element_get_bus(pipeline.get()), &gst_object_unref);
		gint64 deadline = g_get_monotonic_time() + timeout_sec * G_TIME_SPAN_SECOND;

		while (!m_probe_result.ready && g_get_monotonic_time() < deadline) {
			GstMessage* msg = gst_bus_timed_pop(bus.get(), 200 * GST_MSECOND);
			if (!msg) {
				continue;
			}

			if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
				GError* err;
				gchar* dbg;
				gst_message_parse_error(msg, &err, &dbg);

				std::ostringstream oss;

				oss << "GStreamer error from " << GST_OBJECT_NAME(msg->src) << ": "
					<< (err && err->message ? err->message : "unknown error")
					<< (dbg ? std::string(" | debug: ") + dbg : "");
				m_logger.error(oss.str());

				if (err) g_error_free(err);
				if (dbg) g_free(dbg);
				gst_message_unref(msg);

				break;
			}

			gst_message_unref(msg);
		}

		gst_element_set_state(pipeline.get(), GST_STATE_NULL);
		if (m_probe_result.ready) {
			return true;
		}
		else {
			return false;
		}
	}

	bool UCamera::probe_camera_with_reconnect(int attempts, int timeout_sec, int reconnect_delay_sec)
	{
		std::string error;

		m_logger.info("Probe camera stream!");

		for (int i = 1; i <= attempts; ++i) {
			std::ostringstream oss;
			oss << "Try " << i << "/" << attempts << " connecting...";
			m_logger.info(oss.str());

			auto sleep_f = [&]() {
				if (i < attempts) {
					std::this_thread::sleep_for(
						std::chrono::seconds(reconnect_delay_sec));
				}
			};

			if (!codec_check_probe(timeout_sec)) {
				m_logger.error("Failed check codec!");
				sleep_f();
				continue;
			}

			if (!camera_probe(timeout_sec)) {
				m_logger.error("Failed camera probe!");
				sleep_f();
				continue;
			}

			return true;
		}

		m_logger.error("Camera unreachable after retries");
		return false;
	}

	// ====================================
	//     GStreaming Получение кадров с камер
	// ====================================

	bool UCamera::start_reading_pipeline() {
		if (!m_main_pipeline) {
			m_logger.error("Reading pipeline is not existing! Failed to start");
			m_probe_result.ready = false;
			return false;
		}
		else {
			if (m_main_pipeline.get()->current_state == GST_STATE_PLAYING) {
				m_logger.warn("Reading pipeline already playing! Warning at start!");
				return true;
			}
			else {
				// Запуска reading pipeline
				gst_element_set_state(m_main_pipeline.get(), GST_STATE_PLAYING);
				return true;
			}
		}
	}

	bool UCamera::start_pipeline(std::string pipeline_str) {
		TUniqueGst& pipeline = pipeline_str == std::string("main") ? m_main_pipeline : m_sub_pipeline;
		if (!pipeline) {
			m_logger.error(std::string(gst_element_get_name(pipeline.get())) + " is not existing! Failed to start!");
			return false;
		}
		else {
			if (pipeline.get()->current_state == GST_STATE_PLAYING) {
				m_logger.warn(std::string(gst_element_get_name(pipeline.get())) + " pipeline already playing!Warning at start!");
				return true;
			}
			else {
				// Запуска reading pipeline
				gst_element_set_state(m_main_pipeline.get(), GST_STATE_PLAYING);
				m_logger.info(std::string(gst_element_get_name(pipeline.get())) + " successfully started!");
				return true;
			}
		}
	}

	bool UCamera::initialize_main_pipeline() {

		if (m_probe_result.ready == false) {
			m_logger.error("Failed to initialize reading gst pipeline due to failed probing!");
			return false;
		}

		m_main_pipeline = TUniqueGst(gst_pipeline_new("reading_pipeline"), &gst_object_unref);

		std::string depay_str, parse_str;
		if (m_probe_result.codec_name == std::string("H264")) {
			depay_str = "rtph264depay";
			parse_str = "h264parse";
		}
		else {
			depay_str = "rtph265depay";
			parse_str = "h265parse";
		}

		auto src = gst_element_factory_make("rtspsrc", "src");
		auto depay = gst_element_factory_make(depay_str.c_str(), "depay");
		auto parse = gst_element_factory_make(parse_str.c_str(), "parse");
		m_main_split_tee = TUniqueGst(gst_element_factory_make("tee", "tee_branch"), &gst_object_unref);
		auto deconding_queue = gst_element_factory_make("queue", "deconding_queue");
		auto decoder = gst_element_factory_make("mppvideodec", "decoder");
		auto sink = gst_element_factory_make("appsink", "sink");

		auto clean_up = [&]() {
			m_main_pipeline.reset();

			if (src) gst_object_unref(src);
			if (depay) gst_object_unref(depay);
			if (parse) gst_object_unref(parse);
			if (deconding_queue) gst_object_unref(deconding_queue);
			if (decoder) gst_object_unref(decoder);
			if (sink) gst_object_unref(sink);
		};

		if (!m_main_pipeline || !src || !depay || !parse || !m_main_split_tee || !deconding_queue || !decoder || !sink) {
			std::ostringstream oss;
			oss << "Failed to create elements at reading pipeline: "
				<< "\n\tpipeline=" << (m_main_pipeline ? "OK" : "NULL") << ","
				<< "\n\tsrc=" << (src ? "OK" : "NULL") << ","
				<< "\n\tdepay=" << (depay ? "OK" : "NULL") << ","
				<< "\n\tparse=" << (parse ? "OK" : "NULL") << ","
				<< "\n\ttee=" << (m_main_split_tee ? "OK" : "NULL") << ","
				<< "\n\tdeconding_queue=" << (deconding_queue ? "OK" : "NULL") << ","
				<< "\n\tdecoder=" << (decoder ? "OK" : "NULL") << ","
				<< "\n\tsink=" << (sink ? "OK" : "NULL") << ",";
			m_logger.error(oss.str());
			clean_up();
			return false;
		}

		g_object_set(
			src,
			"location", m_options.main_rtsp_url.c_str(),
			"latency", m_options.main_latency,
			"protocols", m_options.b_main_udp ? GST_RTSP_LOWER_TRANS_UDP : GST_RTSP_LOWER_TRANS_TCP,
			nullptr
		);

		g_object_set(sink,
			"emit-signals", TRUE,
			"sync", FALSE,
			"max-buffers", 1,
			"drop", TRUE,
			nullptr
		);

		g_object_set(
			parse,
			"config-interval", -1,
			nullptr
		);

		g_object_set(deconding_queue,
			"max-size-buffers", 3,
			"max-size-bytes", 0,
			"max-size-time", (guint64)1 * GST_SECOND,
			"leaky", 2,
			nullptr
		);

		gst_bin_add_many(GST_BIN(m_main_pipeline.get()),
			src, depay, parse, m_main_split_tee.get(), deconding_queue, decoder, sink, nullptr
		);

		// Связывание основного потока
		if (!gst_element_link_many(depay, parse, m_main_split_tee.get(), nullptr)) {
			m_logger.error("Error with linking: src, depay, parse, tee!");
			return false;
		}

		// Связывание ветки с декодером
		// Связывание tee с decoding_queue
		GstPad* tee_decode_pad = gst_element_request_pad_simple(m_main_split_tee.get(), "src_%u");
		//GstPad* tee_decode_pad = gst_element_get_request_pad(m_reading_tee.get(), "src_%u");
		GstPad* queue_decode_pad = gst_element_get_static_pad(deconding_queue, "sink");

		if (gst_pad_link(tee_decode_pad, queue_decode_pad) != GST_PAD_LINK_OK) {
			m_logger.error("Failed to link tee to decoding queue");
			return false;
		}

		gst_object_unref(queue_decode_pad);

		// Связывание остальных элементов
		if (!gst_element_link_many(deconding_queue, decoder, sink, nullptr)) {
			m_logger.error("Error with linking: tee, deconding_queue, decoder, sink!");
			return false;
		}

		// Динамическое связывание падов src с depay
		g_signal_connect(src, "pad-added", G_CALLBACK(+[](
			GstElement* src,
			GstPad* pad,
			gpointer data
			) {
				GstElement* depay = static_cast<GstElement*>(data);
				GstPad* sink_pad = gst_element_get_static_pad(depay, "sink");

				if (gst_pad_is_linked(sink_pad)) {
					gst_object_unref(sink_pad);
					return;
				}

				if (gst_pad_link(pad, sink_pad) != GST_PAD_LINK_OK) {
					g_printerr("Failed to link rtspsrc to jitterbuffer\n");
				}

				gst_object_unref(sink_pad);
			}), depay);

		// Обработка полученных кадров
		//g_signal_connect(sink, "new-sample",
		//	G_CALLBACK(UCamera::on_new_sample), this);

		// В случае, если передан путь для сохранения файлов
		if (!m_options.record_path.empty()) {
			m_logger.info("A path for recording segments has been found: " + m_options.record_path.string());
			m_logger.info("Creating brach to record segments...");
			if (!std::filesystem::exists(m_options.record_path)) {
				try {
					std::filesystem::create_directories(m_options.record_path);
				}
				catch (...) {
					m_logger.error("Cannot create directories at path: " +
						m_options.record_path.string());
					return false;
				}
			}

			auto record_queue = gst_element_factory_make("queue", "record_queue");
			auto splitmux = gst_element_factory_make("splitmuxsink", "splitmux");

			if (!record_queue || !splitmux) {
				std::ostringstream oss;
				oss << "Failed to create elements at record tee: "
					<< "\n\rrecord_queue=" << (record_queue ? "OK" : "NULL") << ","
					<< "\n\tsplitmux=" << (splitmux ? "OK" : "NULL") << ",";
				m_logger.error(oss.str());
				return false;
			}

			std::string filename = "segment_" + make_start_timestamp() + "_n_%05d.mp4";
			std::filesystem::path mp4_path = m_options.record_path / filename;

			g_object_set(
				splitmux,
				"location", mp4_path.string().c_str(),
				"max-size-time", static_cast<guint64>(m_options.segment_duration) * GST_SECOND,
				"muxer-factory", "mp4mux",
				nullptr
			);

			gst_bin_add_many(GST_BIN(m_main_pipeline.get()), record_queue, splitmux, nullptr);

			// Связывание падов tee
			GstPad* tee_record_pad = gst_element_request_pad_simple(m_main_split_tee.get(), "src_%u");
			GstPad* queue_record_pad = gst_element_get_static_pad(record_queue, "sink");

			if (gst_pad_link(tee_record_pad, queue_record_pad) != GST_PAD_LINK_OK) {
				m_logger.error("Failed to link tee to record queue");
				return false;
			}

			gst_object_unref(queue_record_pad);

			// Связывание остальные элеентов
			if (!gst_element_link_many(record_queue, splitmux, nullptr)) {
				m_logger.error("Failed to link file record tee: tee, record_queue, splitmux");
				return false;
			}
			m_logger.info("Recording brach successfully creatad!");
		}

		return true;
	}

	bool UCamera::initialize_sub_pipeline() {
		if (m_probe_result.ready == false) {
			m_logger.error("Failed to initialize reading gst pipeline due to failed probing!");
			return false;
		}

		m_main_pipeline = TUniqueGst(gst_pipeline_new("sub"), &gst_object_unref);

		std::string depay_str, parse_str, pay_str;
		if (m_probe_result.codec_name == std::string("H264")) {
			depay_str = "rtph264depay";
			parse_str = "h264parse";
			pay_str = "rtph264pay";
		}
		else {
			depay_str = "rtph265depay";
			parse_str = "h265parse";
			pay_str = "rtph265pay";
		}

		auto src = gst_element_factory_make("rtspsrc", "src");
		auto depay = gst_element_factory_make(depay_str.c_str(), "depay");
		auto parse = gst_element_factory_make(parse_str.c_str(), "parse");
		auto pay = gst_element_factory_make(pay_str.c_str(), "pay");
		m_sub_tee = TUniqueGst(gst_element_factory_make("tee", "tee"), &gst_object_unref);
		auto queue = gst_element_factory_make("queue", "fake_queue");
		auto sink = gst_element_factory_make("fakesink", "fake");

		auto clean_up = [&]() {
			m_main_pipeline.reset();

			if (src) gst_object_unref(src);
			if (depay) gst_object_unref(depay);
			if (parse) gst_object_unref(parse);
			if (pay) gst_object_unref(pay);
			if (queue) gst_object_unref(queue);
			if (sink) gst_object_unref(sink);
		};

		if (!m_main_pipeline || !src || !depay || !parse || !pay || !m_main_split_tee || !queue || !sink) {
			std::ostringstream oss;
			oss << "Failed to create elements at reading pipeline: "
				<< "\n\tpipeline=" << (m_sub_pipeline ? "OK" : "NULL") << ","
				<< "\n\tsrc=" << (src ? "OK" : "NULL") << ","
				<< "\n\tdepay=" << (depay ? "OK" : "NULL") << ","
				<< "\n\tparse=" << (parse ? "OK" : "NULL") << ","
				<< "\n\tpay=" << (pay ? "OK" : "NULL") << ","
				<< "\n\ttee=" << (m_sub_tee ? "OK" : "NULL") << ","
				<< "\n\tqueue=" << (queue ? "OK" : "NULL") << ","
				<< "\n\tsink=" << (sink ? "OK" : "NULL") << ",";

			m_logger.error(oss.str());
			clean_up();
			return false;
		}

		g_object_set(
			src,
			"location", m_options.main_rtsp_url.c_str(),
			"latency", m_options.sub_latency,
			"protocols", m_options.b_sub_udp ? GST_RTSP_LOWER_TRANS_UDP : GST_RTSP_LOWER_TRANS_TCP,
			nullptr
		);

		g_object_set(sink,
			"sync", FALSE,
			nullptr
		);

		g_object_set(
			parse,
			"config-interval", 1,
			nullptr
		);

		g_object_set(queue,
			"max-size-buffers", 0,
			"max-size-bytes", 0,
			"max-size-time", 0,
			"leaky", 2,
			nullptr
		);

		gst_bin_add_many(GST_BIN(m_sub_pipeline.get()),
			src, depay, parse, pay, m_sub_tee.get(), queue, sink, nullptr
		);

		// Связывание основного потока
		if (!gst_element_link_many(depay, parse, pay, m_sub_pipeline.get(), nullptr)) {
			m_logger.error("Error with linking: src, depay, parse, tee!");
			return false;
		}

		// Связывание ветки с декодером
		// Связывание tee с decoding_queue
		GstPad* tee_sub_pad = gst_element_request_pad_simple(m_sub_tee.get(), "src_%u");
		//GstPad* tee_decode_pad = gst_element_get_request_pad(m_reading_tee.get(), "src_%u");
		GstPad* queue_pad = gst_element_get_static_pad(queue, "sink");

		if (gst_pad_link(tee_sub_pad, queue_pad) != GST_PAD_LINK_OK) {
			m_logger.error("Failed to link tee to decoding queue");
			return false;
		}

		gst_object_unref(queue_pad);

		if (!gst_element_link(queue, sink)) {
			m_logger.error("Error with linking sub pipeline: queue, sink!");
			return false;
		}

		// Динамическое связывание падов src с depay
		g_signal_connect(src, "pad-added", G_CALLBACK(+[](
			GstElement* src,
			GstPad* pad,
			gpointer data
			) {
				GstElement* depay = static_cast<GstElement*>(data);
				GstPad* sink_pad = gst_element_get_static_pad(depay, "sink");

				if (gst_pad_is_linked(sink_pad)) {
					gst_object_unref(sink_pad);
					return;
				}

				if (gst_pad_link(pad, sink_pad) != GST_PAD_LINK_OK) {
					g_printerr("Failed to link rtspsrc to jitterbuffer\n");
				}

				gst_object_unref(sink_pad);
			}), depay);
	}
	*/
	// ===========================================================
	// Релиазация обмена сообщений SDP и ICE
	// ===========================================================

	void UCamera::start_websocket_client()
	{
		std::string url = "/camera/" + m_options.name;
		if (!m_websocket_client) {
			m_websocket_client = std::make_shared<UWebSocketClient>(m_io_context, m_socket_options.ip_adress, m_socket_options.port, url, m_options.name);
		}

		m_websocket_client->set_message_callback(
			[this](const std::string& message) {
				this->on_signaling_message(message);
			}
		);

		m_websocket_thread = std::thread([this]() {
			try {
				m_websocket_client->run();

				m_io_context.run();
			}
			catch (std::exception& error) {
				std::cerr << color::red << "[UCamera] Start websocket client error: " << error.what() << color::reset << std::endl;
			}
			});
	}

	void UCamera::stop_websocket_client()
	{
		m_work_guard.reset();
		m_io_context.stop();

		if (m_websocket_thread.joinable()) {
			m_websocket_thread.join();
		}
	}

	void UCamera::on_signaling_message(const std::string& msg) {
		try {
			boost::json::value parsed = boost::json::parse(msg);
			boost::json::object& json_object = parsed.as_object();

			// Узнаем идентификатор клиента
			std::string client_id;
			if (auto* v = json_object.if_contains("client_id"); v && v->is_string()) {
				client_id = v->as_string().c_str();
			}
			else {
				m_logger.error("Error with recieving message: missing client id!");
				return;
			}

			// Проверяем тип сообщения
			std::string type;
			if (auto* v = json_object.if_contains("type"); v && v->is_string()) {
				type = v->as_string().c_str();
			}
			else {
				m_logger.error("Error while receiving message: missing type!");
				return;
			}

			std::string description;
			// Запрос на соединение
			if (type == "connection" || type == "close") {
				const bool ret = (type == "connection")
					? m_sub->create_webrtc_session(client_id, description)
					: m_sub->close_webrtc_session(client_id, description);

				ret ? m_logger.info(description) : m_logger.error(description);

				send_message(
					boost::json::serialize(
						json(client_id, ret, type, description)
					)
				);

				return;
			}
			else {
				auto ret = m_sub->process_webrtc_session(client_id, json_object, type, description);
				ret ? m_logger.info(description) : m_logger.error(description);
				//send_message(
				//	boost::json::serialize(
				//		json(client_id, ret, type, description)
				//	)
				//);
			}
		}
		catch (const std::exception e) {
			std::string err_text = "Unexpected error: " + std::string(e.what());
			m_logger.error(err_text);
			send_message(
				boost::json::serialize(
					json("", false, "fault", err_text)
				)
			);
		}
	}

	/*
	void UCamera::open_new_session(const std::string& client_id) {
		if (m_probe_result.codec_name.empty()) {
			std::string err_text = "Cannot create new session: failed to probe video!";
			m_logger.error(err_text);
			send_message(boost::json::serialize(
				json(client_id, false, SIG_TYPE_CONNECT, err_text))
			);
			return;
		}

		if (m_opened_sessions.find(client_id) != m_opened_sessions.end()) {
			m_logger.warn("Session with client " + client_id + " has already created!");
			send_message(boost::json::serialize(
				json(client_id, false, SIG_TYPE_CONNECT, "Session with this client has already started!"))
			);
			return;
		}

		auto session = std::make_unique<UWebRTCSession>(
			client_id, 
			m_options.name, 
			true,
			m_sub_pipeline.get(),
			m_sub_tee.get(),
			[this](const std::string& message) {this->send_message(message); },
			m_logger
		);

		if (!session) {
			m_logger.error("Error creation new session!");
			return;
		}

		auto [it, inserted] = m_opened_sessions.emplace(client_id, std::move(session));

		it->second->create_branch(m_probe_result.codec_name);
	}

	void UCamera::close_session(const std::string& client_id) {
		auto it = m_opened_sessions.find(client_id);
		if (it == m_opened_sessions.end()) {
			send_message(boost::json::serialize(
				json("unknown", false, SIG_TYPE_CONNECT, "There are no one opened sessions!")
			));
			m_logger.error("Error closing session: session with client " + client_id + " doesn't exist!");
			return;
		}
		try {
			m_opened_sessions.erase(client_id);
			m_logger.info("Seccessfully removed session with " + client_id);
		}
		catch (const std::exception& e) {
			m_logger.error("Error with closing session client " + client_id + ": " + std::string(e.what()));
		}
	}
	*/


	void UCamera::set_signaling_callback(CSignalingCallback callback) {
		m_signaling_callback = std::move(callback);
	}

	void UCamera::send_message(const std::string& message)
	{
		std::lock_guard lock(m_signal_mutex);
		if (m_websocket_client) {
			m_websocket_client->send(message);
		}
		else {
			std::cout << color::red << "[UCamera " << m_options.name << "] Cannot send message because websocket client is nullptr!\n" << color::reset;
		}
	}

	boost::json::object UCamera::json(
		const std::string& client,
		bool successed,
		const std::string& type,
		const std::string& description
	) 
	{
		boost::json::object message;
		message[SIG_TYPE] = type;
		message[SIG_SENDER] = SIG_SENDER_CAMERA;
		message[SIG_RET] = successed ? SIG_RET_SUCCESS : SIG_RET_FAULT;
		message[SIG_CLIENT] = client;
		message[SIG_CAMERA] = m_options.name;
		message[SIG_DECRIPTION] = description;
		return message;
	}

} // namespace neural
} // namespace varan