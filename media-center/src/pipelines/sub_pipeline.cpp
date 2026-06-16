#include "video_pipeline.h"
#include <thread>

#include <gst/rtsp/gstrtsptransport.h>

#include "utility/json-definers.h"

#define SUB_TEE "tee_sub"

UCameraSubPipeline::~UCameraSubPipeline() {
	
}

bool UCameraSubPipeline::initialize() {
	if (m_has_initialized == true) {
		return true;
	}

	if (!UCameraPipeline::initialize()) {
		return false;
	}

	std::string tee_str = SUB_TEE;
	if (m_webrtc_sessions.find(tee_str) != m_webrtc_sessions.end()) {
		m_logger->error("Cannot create pipeline, context still exists!");
		return false;
	}

	m_pipeline = gst_pipeline_new(m_parameters.name.c_str());

	// Привязываем рестарт к пайплайну
	GstBus* bus = gst_element_get_bus(m_pipeline);
	gst_bus_add_watch(bus,
		+[](GstBus* bus, GstMessage* msg, gpointer data) -> gboolean
		{
			auto self = static_cast<UCameraSubPipeline*>(data);

			switch (GST_MESSAGE_TYPE(msg)) {
				case GST_MESSAGE_ERROR: {
					// обработка ошибки записи
					GError* err = nullptr;
					gchar* debug = nullptr;
					gst_message_parse_error(msg, &err, &debug);

					self->m_logger->error(
						"GStreamer ERROR: " + std::string(err ? err->message : "unknown")
					);

					if (err) g_error_free(err);
					if (debug) g_free(debug);

					//self->shedule_restart();
					break;
				}
				case GST_MESSAGE_EOS: {
					self->m_logger->warn("GStreamer EOS received");
					//self->destroy();
					break;
				}
				case GST_MESSAGE_ELEMENT: {
					const GstStructure* s = gst_message_get_structure(msg);
					if (s && gst_structure_has_name(s, "GstRTSPSrcTimeout"))
					{
						self->m_logger->warn("RTSP timeout detected");
						self->shedule_restart();
					}
					break;
				}
				default:
					break;
			}
			return TRUE;
		},
		this
	);
	gst_object_unref(bus);

	std::string depay_str = m_probe.codec_name == std::string("H264") ? "rtph264depay" : "rtph265depay";
	std::string parse_str = m_probe.codec_name == std::string("H264") ? "h264parse" : "h265parse";
	std::string pay_str = m_probe.codec_name == std::string("H264") ? "rtph264pay" : "rtph265pay";

	auto src = gst_element_factory_make("rtspsrc", "src");
	auto depay = gst_element_factory_make(depay_str.c_str(), "depay");
	auto parse = gst_element_factory_make(parse_str.c_str(), "parse");
	auto pay = gst_element_factory_make(pay_str.c_str(), "pay");
	auto pay_queue = gst_element_factory_make("queue", "pay_queue");
	auto tee = gst_element_factory_make("tee", tee_str.c_str());
	auto queue = gst_element_factory_make("queue", "fake_queue");
	auto sink = gst_element_factory_make("fakesink", "fake");

	auto clean_up = [&]() {
		if (m_pipeline) gst_object_unref(m_pipeline);

		if (src) gst_object_unref(src);
		if (depay) gst_object_unref(depay);
		if (parse) gst_object_unref(parse);
		if (pay) gst_object_unref(pay);
		if (pay_queue) gst_object_unref(pay_queue);
		if (tee) gst_object_unref(tee);
		if (queue) gst_object_unref(queue);
		if (sink) gst_object_unref(sink);
	};

	if (!m_pipeline || !src || !depay || !parse || !pay || !pay_queue || !tee || !queue || !sink) {
		std::ostringstream oss;
		oss << "Failed to create elements at reading pipeline: "
			<< "\n\tpipeline=" << (m_pipeline ? "OK" : "NULL") << ","
			<< "\n\tsrc=" << (src ? "OK" : "NULL") << ","
			<< "\n\tdepay=" << (depay ? "OK" : "NULL") << ","
			<< "\n\tparse=" << (parse ? "OK" : "NULL") << ","
			<< "\n\tpay=" << (pay ? "OK" : "NULL") << ","
			<< "\n\tqueue=" << (pay_queue ? "OK" : "NULL") << ","
			<< "\n\ttee=" << (tee ? "OK" : "NULL") << ","
			<< "\n\tqueue=" << (queue ? "OK" : "NULL") << ","
			<< "\n\tsink=" << (sink ? "OK" : "NULL") << ",";

		m_logger->error(oss.str());
		clean_up();
		return false;
	}

	g_object_set(
		src,
		"location", m_parameters.rtsp_url.c_str(),
		"latency", m_parameters.latency,
		"protocols", m_parameters.use_udp ? GST_RTSP_LOWER_TRANS_UDP : GST_RTSP_LOWER_TRANS_TCP,
		"drop-on-latency", TRUE,
		nullptr
	);

	g_object_set(sink,
		"sync", FALSE,
		nullptr
	);

	g_object_set(
		parse,
		"config-interval", -1,
		nullptr
	);

	g_object_set(
		pay,
		"config-interval", -1,
		"pt", 96,
		nullptr
	);

	g_object_set(pay_queue,
		"max-size-buffers", 0,
		"max-size-bytes", 0,
		"max-size-time", 0,
		nullptr
	);

	g_object_set(queue,
		"max-size-buffers", 0,
		"max-size-bytes", 0,
		"max-size-time", 0,
		"leaky", 2,
		nullptr
	);

	gst_bin_add_many(GST_BIN(m_pipeline),
		src, depay, parse, pay, pay_queue, tee, queue, sink, nullptr
	);

	// Связывание основного потока
	if (!gst_element_link_many(depay, parse, pay, pay_queue, tee, nullptr)) {
		m_logger->error("Error with linking: src, depay, parse, tee!");
		return false;
	}

	// Связывание ветки с декодером
	// Связывание tee с decoding_queue
	GstPad* tee_sub_pad = gst_element_request_pad_simple(tee, "src_%u");
	//GstPad* tee_decode_pad = gst_element_get_request_pad(m_reading_tee.get(), "src_%u");
	GstPad* queue_pad = gst_element_get_static_pad(queue, "sink");

	if (gst_pad_link(tee_sub_pad, queue_pad) != GST_PAD_LINK_OK) {
		m_logger->error("Failed to link tee to decoding queue");
		return false;
	}

	gst_object_unref(queue_pad);

	if (!gst_element_link(queue, sink)) {
		m_logger->error("Error with linking sub pipeline: queue, sink!");
		return false;
	}

	m_tees.try_emplace(tee_str, tee);

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
		}), 
		depay
	);

	m_has_initialized = true;
	m_logger->info("initialize(): pipeline successfully initialized!");
	return m_has_initialized;
}

bool UCameraSubPipeline::create_webrtc_session(const std::string& client_id, std::string& description)
{
	if (!UCameraPipeline::create_webrtc_session(client_id, description)) {
		return false;
	}

	auto remove_callback = [this](const std::string& client_id, std::string& description) {
		return this->close_webrtc_session(client_id, description);
	};

	auto session = std::make_unique<UWebRTCSession>(
		client_id,
		m_parameters.camera_name,
		true,
		m_pipeline,
		m_tees[std::string(SUB_TEE)],
		m_send_callback,
		remove_callback,
		m_logger.get()
	);

	if (!session) {
		description = "Error creation new session!";
		return false;
	}

	auto [it, inserted] = m_webrtc_sessions.emplace(client_id, std::move(session));

	auto ret = it->second->create_branch(m_probe.codec_name);
	if (ret) {
		m_logger->info("Successfully created webrtc session branch with client " + client_id);
		description = "Connection resolved!";
	}
	else {
		m_logger->warn("Error creation webrtc session branch with client " + client_id);
		description = "Connection doesn't resolved!";
	}
	return ret;
}

FPipelineData UCameraSubPipeline::get_pipeline_data() {
	FPipelineData data;

	data.name = m_parameters.name;
	data.status = get_status();
	data.type = EPilelineType::SUB;

	data.width = m_probe.ready() ? m_probe.width : 0;
	data.height = m_probe.ready() ? m_probe.height : 0;
	data.fps = m_probe.ready() ? 25 : 0;
	data.codec = m_probe.ready() ? m_probe.codec_name : "";

	data.rtsp_url = m_parameters.rtsp_url;
	data.use_udp = m_parameters.use_udp;
	data.reconnect_time = m_parameters.reconnect_delay;
	data.latency = m_parameters.latency;
	
	data.to_record = false;
	data.record_path = "";
	data.segment_length = -1;

	data.sub = m_parameters.stream;

	return data;
}

EPilelineType UCameraSubPipeline::get_type() {
	return EPilelineType::SUB;
}