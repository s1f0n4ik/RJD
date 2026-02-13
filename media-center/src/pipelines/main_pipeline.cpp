#include "video_pipeline.h"
#include <filesystem>

#include <gst/rtsp/gstrtsptransport.h>

#include "video_utility.h"

#define MAIN_TEE "tee_main"

bool UCameraMainPipeline::initialize() {
	if (!UCameraPipeline::initialize()) {
		return false;
	}

	// Создание основного пайплайна
	m_pipeline = gst_pipeline_new(m_parameters.name.c_str());

	std::string depay_str = m_probe.codec_name == std::string("H264") ? "rtph264depay" : "rtph265depay";
	std::string parse_str = m_probe.codec_name == std::string("H264") ? "h264parse" : "h265parse";


	auto src = gst_element_factory_make("rtspsrc", "src");
	auto depay = gst_element_factory_make(depay_str.c_str(), "depay");
	auto parse = gst_element_factory_make(parse_str.c_str(), "parse");

	std::string tee_str = MAIN_TEE;
	if (m_tees.find(tee_str) == m_tees.end()) {
		m_logger.error("Already exists tee with name " + tee_str);
		return false;
	}
	auto tee = gst_element_factory_make("tee", MAIN_TEE);

	auto deconding_queue = gst_element_factory_make("queue", "deconding_queue");
	auto decoder = gst_element_factory_make("mppvideodec", "decoder");
	auto sink = gst_element_factory_make("appsink", "sink");

	auto clean_up = [&]() {
		if (m_pipeline) gst_object_unref(m_pipeline);
		if (src) gst_object_unref(src);
		if (depay) gst_object_unref(depay);
		if (parse) gst_object_unref(parse);
		if (tee) gst_object_unref(tee);
		if (deconding_queue) gst_object_unref(deconding_queue);
		if (decoder) gst_object_unref(decoder);
		if (sink) gst_object_unref(sink);
	};

	if (!m_pipeline || !src || !depay || !parse || !tee || !deconding_queue || !decoder || !sink) {
		std::ostringstream oss;
		oss << "Failed to create elements at reading pipeline: "
			<< "\n\tpipeline=" << (m_pipeline ? "OK" : "NULL") << ","
			<< "\n\tsrc=" << (src ? "OK" : "NULL") << ","
			<< "\n\tdepay=" << (depay ? "OK" : "NULL") << ","
			<< "\n\tparse=" << (parse ? "OK" : "NULL") << ","
			<< "\n\ttee=" << (tee ? "OK" : "NULL") << ","
			<< "\n\tdeconding_queue=" << (deconding_queue ? "OK" : "NULL") << ","
			<< "\n\tdecoder=" << (decoder ? "OK" : "NULL") << ","
			<< "\n\tsink=" << (sink ? "OK" : "NULL") << ",";
		m_logger.error(oss.str());
		clean_up();
		return false;
	}

	g_object_set(
		src,
		"location", m_parameters.rtsp_url.c_str(),
		"latency", m_parameters.latency,
		"protocols", m_parameters.use_udp ? GST_RTSP_LOWER_TRANS_UDP : GST_RTSP_LOWER_TRANS_TCP,
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

	gst_bin_add_many(GST_BIN(m_pipeline),
		src, depay, parse, tee, deconding_queue, decoder, sink, nullptr
	);

	// Связывание основного потока
	if (!gst_element_link_many(depay, parse, tee, nullptr)) {
		m_logger.error("Error with linking: src, depay, parse, tee!");
		return false;
	}

	// Связывание ветки с декодером
	// Связывание tee с decoding_queue
	GstPad* tee_decode_pad = gst_element_request_pad_simple(tee, "src_%u");
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
	if (!m_parameters.record_path.empty()) {
		m_logger.info("A path for recording segments has been found: " + m_parameters.record_path);
		m_logger.info("Creating brach to record segments...");
		if (!std::filesystem::exists(m_parameters.record_path)) {
			try {
				std::filesystem::create_directories(m_parameters.record_path);
			}
			catch (...) {
				m_logger.error("Cannot create directories at path: " +
					m_parameters.record_path);
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
		std::filesystem::path mp4_path =std::filesystem::path(m_parameters.record_path) / filename;

		g_object_set(
			splitmux,
			"location", mp4_path.string().c_str(),
			"max-size-time", static_cast<guint64>(m_parameters.segment_length) * GST_SECOND,
			"muxer-factory", "mp4mux",
			nullptr
		);

		gst_bin_add_many(GST_BIN(m_pipeline), record_queue, splitmux, nullptr);

		// Связывание падов tee
		GstPad* tee_record_pad = gst_element_request_pad_simple(tee, "src_%u");
		GstPad* queue_record_pad = gst_element_get_static_pad(record_queue, "sink");

		if (gst_pad_link(tee_record_pad, queue_record_pad) != GST_PAD_LINK_OK) {
			m_logger.error("Failed to link tee to record queue");
			return false;
		}

		gst_object_unref(queue_record_pad);

		m_tees[tee_str] = tee;

		// Связывание остальные элеентов
		if (!gst_element_link_many(record_queue, splitmux, nullptr)) {
			m_logger.error("Failed to link file record tee: tee, record_queue, splitmux");
			return false;
		}
		is_initialized = true;
		m_logger.info("Recording brach successfully creatad!");
	}

	return true;
}

bool UCameraMainPipeline::create_webrtc_session(const std::string& client_id, std::string& description)
{
	if (!UCameraPipeline::create_webrtc_session(client_id, description)) {
		return false;
	}

	auto session = std::make_unique<UWebRTCSession>(
		client_id,
		m_parameters.camera_name,
		true,
		m_pipeline,
		m_tees[std::string(MAIN_TEE)],
		std::move(m_parameters.send_callback),
		m_logger
	);

	if (!session) {
		m_logger.error("Error creation new session!");
		return;
	}

	auto [it, inserted] = m_webrtc_sessions.emplace(client_id, std::move(session));

	it->second->create_branch(m_probe.codec_name);
}