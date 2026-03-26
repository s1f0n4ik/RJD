#include "video_pipeline.h"
#include <filesystem>

#include <gst/rtsp/gstrtsptransport.h>

#include <gst/video/video.h>
#include <gst/video/gstvideometa.h>
#include <gst/allocators/gstdmabuf.h>

#include "video_utility.h"
#include "utility/json-definers.h"

#define MAIN_TEE "tee_main"

UCameraMainPipeline::UCameraMainPipeline(
	const FInputPipelineParameters& parameters,
	std::unique_ptr<ULogger> logger,
	std::function<void(std::string)> send_callback,
	CDmabufMover dma_callback
)
	: UCameraPipeline(parameters, std::move(logger), send_callback)
	, m_dma_sender(std::move(dma_callback))
	, m_record_branch(FPipelineBranch(EBranchType::RECORD, "record"))
	, m_decoder_branch(FPipelineBranch(EBranchType::DECODER, "decoder"))
{
}

UCameraMainPipeline::~UCameraMainPipeline() {
	
}

bool UCameraMainPipeline::teardown() {
	std::lock_guard<std::mutex> lock(m_branch_mutex);
	if (!destroy_branch(m_record_branch)) {
		m_logger->warn("teardown(): record branch didn't teardown properly!");
	}

	if (!destroy_branch(m_decoder_branch)) {
		m_logger->warn("teardown(): decoder branch didn't teardown properly!");
	}

	return UCameraPipeline::teardown();
}

bool UCameraMainPipeline::initialize() {
	if (m_has_initialized) {
		return true;
	}

	if (!UCameraPipeline::initialize()) {
		return false;
	}

	// Создание основного пайплайна
	m_pipeline = gst_pipeline_new(m_parameters.name.c_str());

	// Привязываем рестарт к пайплайну
	GstBus* bus = gst_element_get_bus(m_pipeline);

	gst_bus_add_watch(bus,
		+[](GstBus* bus, GstMessage* msg, gpointer data) -> gboolean
		{
			auto self = static_cast<UCameraMainPipeline*>(data);

			switch (GST_MESSAGE_TYPE(msg))
			{
			case GST_MESSAGE_ERROR: {
				// обработка ошибки записи
				if (self->m_record_branch.is_deployed &&
					(GST_MESSAGE_SRC(msg) == GST_OBJECT(self->m_record_branch.elem_1))) {
					self->m_logger->error("splitmux error detected, restarting record branch");
					self->destroy_branch(self->m_record_branch);
					self->create_record_branch(self->m_tees[MAIN_TEE]);
					return TRUE;
				}

				GError* err = nullptr;
				gchar* debug = nullptr;
				gst_message_parse_error(msg, &err, &debug);

				self->m_logger->error(
					"GStreamer ERROR: " + std::string(err ? err->message : "unknown")
				);

				if (err) g_error_free(err);
				if (debug) g_free(debug);


				//self->restart_async();
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
					self->restart_async();
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

	auto src = gst_element_factory_make("rtspsrc", "src");
	auto depay = gst_element_factory_make(depay_str.c_str(), "depay");
	auto parse = gst_element_factory_make(parse_str.c_str(), "parse");

	std::string tee_str = MAIN_TEE;
	if (m_tees.find(tee_str) != m_tees.end()) {
		m_logger->error("Cannot create pipeline, context still exists!");
		return false;
	}
	auto tee = gst_element_factory_make("tee", MAIN_TEE);
	auto fake_queue = gst_element_factory_make("queue", "sink_queue");
	auto fakesink = gst_element_factory_make("fakesink", "sink");

	auto clean_up = [&]() {
		if (m_pipeline) gst_object_unref(m_pipeline);
		if (src) gst_object_unref(src);
		if (depay) gst_object_unref(depay);
		if (parse) gst_object_unref(parse);
		if (tee) gst_object_unref(tee);
		if (fake_queue) gst_object_unref(fake_queue);
		if (fakesink) gst_object_unref(fakesink);
	};

	if (!m_pipeline || !src || !depay || !parse || !tee || !fake_queue || !fakesink) {
		std::ostringstream oss;
		oss << "Failed to create elements at reading pipeline: "
			<< "\n\tpipeline=" << (m_pipeline ? "OK" : "NULL") << ","
			<< "\n\tsrc=" << (src ? "OK" : "NULL") << ","
			<< "\n\tdepay=" << (depay ? "OK" : "NULL") << ","
			<< "\n\tparse=" << (parse ? "OK" : "NULL") << ","
			<< "\n\ttee=" << (tee ? "OK" : "NULL") << ","
			<< "\n\ttee=" << (fake_queue ? "OK" : "NULL") << ","
			<< "\n\tsink=" << (fakesink ? "OK" : "NULL") << ",";
		m_logger->error(oss.str());
		clean_up();
		return false;
	}

	g_object_set(
		src,
		"location", m_parameters.rtsp_url.c_str(),
		"latency", m_parameters.latency,
		"protocols", m_parameters.use_udp ? GST_RTSP_LOWER_TRANS_UDP : GST_RTSP_LOWER_TRANS_TCP,
		"tcp-timeout", (guint64)5 * GST_SECOND,
		nullptr
	);

	g_object_set(fakesink,
		"sync", FALSE,
		nullptr
	);

	g_object_set(
		parse,
		"config-interval", -1,
		nullptr
	);

	gst_bin_add_many(GST_BIN(m_pipeline),
		src, depay, parse, tee, fake_queue, fakesink, nullptr
	);

	// Связывание основного потока
	if (!gst_element_link_many(depay, parse, tee, nullptr)) {
		m_logger->error("Error with linking: src, depay, parse, tee!");
		return false;
	}

	// Связывание ветки с декодером
	// Связывание tee с decoding_queue
	GstPad* tee_pad = gst_element_request_pad_simple(tee, "src_%u");
	GstPad* queue_pad = gst_element_get_static_pad(fake_queue, "sink");

	if (gst_pad_link(tee_pad, queue_pad) != GST_PAD_LINK_OK) {
		m_logger->error("Failed to link tee to decoding queue");
		return false;
	}
	gst_object_unref(queue_pad);

	if (!gst_element_link_many(fake_queue, fakesink, nullptr)) {
		m_logger->error("Error with linking: queue, fakesink!");
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

	// В случае, если передан путь для сохранения файлов
	if (!m_parameters.record_path.empty()) {
		create_record_branch(tee);
	}
	else {
		m_logger->debug("inititalize(): record path not found. Record branch didn't create");
	}

	// Добавить декодировщик
	if (m_dma_sender) {
		create_decoder_branch(tee);
	}
	else {
		m_logger->debug("inititalize(): dmabuf mover callback not found. Decoder branch didn't create");
	}

	m_tees[tee_str] = tee;

	m_has_initialized = true;
	m_logger->info("Pipeline type main successfully creatad!");

	return true;
}

bool UCameraMainPipeline::create_decoder_branch(GstElement* tee) {
	if (!m_probe.ready()) {
		m_logger->error("create_decoder_branch(): cannot create decoder branch probe doesn't ready!");
		return false;
	}

	if (m_decoder_branch.is_deployed) {
		m_logger->warn("create_decoder_branch(): trying to create decode branch that already exists!");
		return true;
	}

	m_logger->debug("Creating branch to decode frames");

	m_decoder_branch.queue = gst_element_factory_make("queue", "decoding_queue");
	m_decoder_branch.elem_1 = gst_element_factory_make("mppvideodec", "decoder");
	m_decoder_branch.elem_2 = gst_element_factory_make("appsink", "appsink");

	if (!m_decoder_branch.queue || !m_decoder_branch.elem_1 || !m_decoder_branch.elem_2) {
		std::ostringstream oss;
		oss << "Failed to create elements at decode tee: "
			<< "\n\rdecode_queue=" << (m_decoder_branch.queue ? "OK" : "NULL") << ","
			<< "\n\tmppvideodec=" << (m_decoder_branch.elem_1 ? "OK" : "NULL") << ","
			<< "\n\tappsink=" << (m_decoder_branch.elem_2 ? "OK" : "NULL");
		m_logger->error(oss.str());
		return false;
	}

	g_object_set(m_decoder_branch.queue,
		"max-size-buffers", 0,
		"leaky", 0,
		nullptr
	);

	g_object_set(m_decoder_branch.elem_2,
		"emit-signals", TRUE,
		"sync", FALSE,
		"max-buffers", 1,
		"drop", TRUE,
		nullptr
	);

	g_object_set(m_decoder_branch.elem_1,
		"dma-feature", true,
		"discard-corrupted-frames", true,
		"fast-mode", true,
		"format", 23,  // NV12
		nullptr
	);

	gst_bin_add_many(GST_BIN(m_pipeline),
		m_decoder_branch.queue, m_decoder_branch.elem_1, m_decoder_branch.elem_2, nullptr
	);

	m_decoder_branch.tee_pad = gst_element_request_pad_simple(tee, "src_%u");
	GstPad* queue_pad = gst_element_get_static_pad(m_decoder_branch.queue, "sink");
	if (gst_pad_link(m_decoder_branch.tee_pad, queue_pad) != GST_PAD_LINK_OK) {
		m_logger->error("Failed to link tee pad with decode branch!");
		gst_object_unref(queue_pad);
		return false;
	}
	gst_object_unref(queue_pad);

	g_signal_connect(
		m_decoder_branch.elem_2,
		"new-sample",
		G_CALLBACK(UCameraMainPipeline::on_new_sample_dma),
		this
	);

	if (!gst_element_link_many(m_decoder_branch.queue, m_decoder_branch.elem_1, m_decoder_branch.elem_2, nullptr)) {
		m_logger->error("Failed to link decoding elements in decode branch!");
		return false;
	}

	m_decoder_branch.is_deployed = true;

	return false;
}

bool UCameraMainPipeline::create_record_branch(GstElement* tee)
{
	if (!m_probe.ready()) {
		m_logger->error("create_record_branch(): cannot create record branch probe doesn't ready!");
		return false;
	}

	if (m_record_branch.is_deployed) {
		m_logger->warn("create_record_branch(): trying to create record branch that already exists!");
		return true;
	}

	m_logger->debug("Creating branch to record segments...");
	m_logger->debug("A path for recording segments has been found: " + m_parameters.record_path.string());
	if (!std::filesystem::exists(m_parameters.record_path)) {
		try {
			std::filesystem::create_directories(m_parameters.record_path);
			m_logger->debug("create_record_branch(): Directory " + m_parameters.record_path.string() + " sucessfully created!");
		}
		catch (...) {
			m_logger->error("create_record_branch(): Cannot create directories at path: " + m_parameters.record_path.string());
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
		m_logger->error(oss.str());
		return false;
	}

	g_object_set(record_queue,
		"max-size-buffers", 50,
		"leaky", 2,
		nullptr
	);

	// Переботка записи фрагмента
	g_signal_connect(splitmux, "format-location",
		G_CALLBACK(+[](GstElement*, guint, gpointer data) -> gchar* {
			auto self = static_cast<UCameraMainPipeline*>(data);

			std::ostringstream oss;
			oss << self->m_parameters.camera_name << "_" << make_start_timestamp() << ".mp4";

			using path = std::filesystem::path;
			path save_path = path(self->m_parameters.record_path) / path(oss.str());

			return g_strdup(save_path.c_str());
		}),
		this
	);

	g_object_set(
		splitmux,
		"max-size-time", static_cast<guint64>(m_parameters.segment_length) * GST_SECOND,
		"muxer-factory", "mp4mux",
		"send-keyframe-requests", TRUE,
		//"async-finalize", TRUE,
		nullptr
	);

	gst_bin_add_many(GST_BIN(m_pipeline), record_queue, splitmux, nullptr);

	// Связывание падов tee
	GstPad* tee_record_pad = gst_element_request_pad_simple(tee, "src_%u");
	GstPad* queue_record_pad = gst_element_get_static_pad(record_queue, "sink");

	if (gst_pad_link(tee_record_pad, queue_record_pad) != GST_PAD_LINK_OK) {
		m_logger->error("Failed to link tee to record queue");
		return false;
	}

	gst_object_unref(queue_record_pad);

	// Связывание остальные элеентов
	if (!gst_element_link(record_queue, splitmux)) {
		m_logger->error("Failed to link file record tee: tee, record_queue, splitmux");
		return false;
	}

	gst_element_sync_state_with_parent(record_queue);
	gst_element_sync_state_with_parent(splitmux);

	m_record_branch.queue = record_queue;
	m_record_branch.elem_1 = splitmux;
	m_record_branch.tee_pad = tee_record_pad;

	m_record_branch.is_deployed = true;

	return true;
}

bool UCameraMainPipeline::destroy_branch(FPipelineBranch& branch) 
{
	if (!m_pipeline) {
		m_logger->error("destroy_branch(): broken pipeline!");
		return false;
	}
	m_logger->debug("destroy_branch(): initialized destroying of " + branch.name + " branch!");
	if (!branch.is_deployed) {
		m_logger->warn("destroy_branch(): trying to teardown " + branch.name + " branch that already destroyed!");
		return true;
	}

	// Остановка отправки изображений в другие модули
	if (branch.type == EBranchType::DECODER) {
		g_signal_handlers_disconnect_by_data(branch.elem_2, this);
		m_logger->debug("destroy_branch(): disconnect signals from decoder element!");
	}

	// Блокировка ветки
	if (branch.tee_pad) {
		gst_pad_add_probe(branch.tee_pad, GST_PAD_PROBE_TYPE_BLOCK_DOWNSTREAM,
			[](GstPad*, GstPadProbeInfo*, gpointer) { return GST_PAD_PROBE_REMOVE; }, nullptr, nullptr);

		GstPad* queue_sink = gst_element_get_static_pad(branch.queue, "sink");
		if (queue_sink) {
			m_logger->debug("destroy_branch(): unlink tee_pad with queue_pad!");
			gst_pad_unlink(branch.tee_pad, queue_sink);
			gst_object_unref(queue_sink);
		}

		gst_element_release_request_pad(m_tees[MAIN_TEE], branch.tee_pad);
		gst_object_unref(branch.tee_pad);
		m_logger->debug("destroy_branch(): relese request tee pad from main pipeline!");
		branch.tee_pad = nullptr;
	}

	// посылаем EOS только в ветку записи
	if ((branch.type == EBranchType::RECORD) && branch.elem_1) {
		m_logger->debug("destroy_branch(): send eos signal to record branch!");
		gst_element_send_event(branch.queue, gst_event_new_eos());
	}

	// Остановка элементов
	if (branch.queue) {
		m_logger->debug("destroy_branch(): turn to NULL state element queue");
		gst_element_set_state(branch.queue, GST_STATE_NULL);
		gst_element_get_state(branch.queue, nullptr, nullptr, GST_CLOCK_TIME_NONE);
	}
	if (branch.elem_1) {
		std::string elem_str = branch.type == EBranchType::DECODER ? "mppvideodec" : "";
		m_logger->debug("destroy_branch(): turn to NULL state element " + elem_str);
		gst_element_set_state(branch.elem_1, GST_STATE_NULL);
		gst_element_get_state(branch.elem_1, nullptr, nullptr, GST_CLOCK_TIME_NONE);
	}
	if (branch.elem_2) {
		std::string elem_str = branch.type == EBranchType::DECODER ? "appsink" : "";
		m_logger->debug("destroy_branch(): turn to NULL state element " + elem_str);
		gst_element_set_state(branch.elem_2, GST_STATE_NULL);
		gst_element_get_state(branch.elem_2, nullptr, nullptr, GST_CLOCK_TIME_NONE);
	}

	if (branch.queue) gst_bin_remove(GST_BIN(m_pipeline), branch.queue);
	if (branch.elem_1) gst_bin_remove(GST_BIN(m_pipeline), branch.elem_1);
	if (branch.elem_2) gst_bin_remove(GST_BIN(m_pipeline), branch.elem_2);

	branch.queue = nullptr;
	branch.elem_1 = nullptr;
	branch.elem_2 = nullptr;

	branch.is_deployed = false;
	m_logger->info("destroy_branch(): " + branch.name + " branch was deleted!");
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
		false,
		m_pipeline,
		m_tees[std::string(MAIN_TEE)],
		m_send_callback,
		std::move(
			[this](const std::string& client_id, std::string& description) {
				return this->close_webrtc_session(client_id, description);
			}
		),
		m_logger.get()
	);

	if (!session) {
		description = "Unresolved error creation new session!";
		return false;
	}

	auto [it, inserted] = m_webrtc_sessions.emplace(client_id, std::move(session));

	auto ret = it->second->create_branch(m_probe.codec_name);
	if (ret) {
		m_logger->info("Successfully created webrtc session branch with client " + client_id);
		description = "Connection resolved!";
	}
	else {
		m_logger->info("Error creation webrtc session branch with client " + client_id);
		description = "Connection doesn't resolved!";
	}
	return ret;
}

void dump_video_info(GstVideoInfo* info) {
	g_print("Video info:\n");
	g_print("  Width: %d\n", info->width);
	g_print("  Height: %d\n", info->height);
	g_print("  Format: %s\n", gst_video_format_to_string(info->finfo->format));
	g_print("  FPS: %d/%d\n", info->fps_n, info->fps_d);
	g_print("  Pixel aspect ratio: %d/%d\n", info->par_n, info->par_d);

	// Вывод stride и offset для каждого плана
	for (int p = 0; p < info->finfo->n_planes; p++) {
		g_print("  Plane %d:\n", p);
		g_print("    Stride: %d\n", info->stride[p]);
		g_print("    Offset: %ld\n", info->offset[p]);
		g_print("    Height (calculated): %ld\n", (info->stride[p] ? info->size / info->stride[p] : 0));
	}

	// Общий размер буфера
	g_print("  Total buffer size: %zu bytes\n", info->size);

}

GstFlowReturn UCameraMainPipeline::on_new_sample_dma(GstElement* sink, gpointer user_data) {
	auto pipeline = static_cast<UCameraMainPipeline*>(user_data);
	if (!pipeline) {
		return GST_FLOW_OK;
	}

	GstSample* sample = gst_app_sink_pull_sample(GST_APP_SINK(sink));
	if (!sample) {
		return GST_FLOW_OK;
	}

	GstBuffer* buffer = gst_sample_get_buffer(sample);
	GstCaps* caps = gst_sample_get_caps(sample);
	if (!buffer || !caps) {
		if (pipeline->m_logger) pipeline->m_logger->debug("on_new_sample_dma(): There is not buffer or caps!");
		gst_sample_unref(sample);
		return GST_FLOW_OK;
	}

	// Получение размера
	GstVideoInfo info;
	if (!gst_video_info_from_caps(&info, caps)) {
		if (pipeline->m_logger) pipeline->m_logger->debug("on_new_sample_dma(): There is no video info!");
		gst_sample_unref(sample);
		return GST_FLOW_OK;
	}

	FDmabufFrame frame;
	// Получние дескрипторов
	guint n_mem = gst_buffer_n_memory(buffer);
	guint num_planes = info.finfo->n_planes;
	if (num_planes < n_mem) {
		if (pipeline->m_logger) pipeline->m_logger->error("on_new_sample_dma(): Count of memory buffers greater then frame planes!");
		gst_sample_unref(sample);
		return GST_FLOW_OK;
	}

	for (guint i = 0; i < n_mem; i++) {
		GstMemory* mem = gst_buffer_peek_memory(buffer, i);
		int fd = dup(gst_dmabuf_memory_get_fd(mem));
		if (fd >= 0) {
			frame.fds.push_back(fd);
		}
	}

	// Получение данных по кадру
	frame.format = std::string(gst_video_format_to_string(info.finfo->format));
	frame.width = info.width;
	frame.height = info.height;
	frame.size = info.size;
	frame.pts = GST_BUFFER_PTS(buffer) / 1e6;
	// Берем данные plane
	for (guint i = 0; i < num_planes; i++) {
		FDmabufPlane plane;
		plane.stride = info.stride[i];
		plane.offset = info.offset[i];
		// Только для NV12
		if (frame.format == "NV12") {
			plane.height = (i == 0) ? info.height : info.height / 2;
		}
		else {
			plane.height = frame.height;
		}

		frame.planes.push_back(std::move(plane));
	}

	// Передаем буфер кадров
	if (pipeline->m_dma_sender) pipeline->m_dma_sender(pipeline->m_parameters.camera_name, std::move(frame));

	gst_sample_unref(sample);

	return GST_FLOW_OK;
}

FPipelineData UCameraMainPipeline::get_pipeline_data() {
	FPipelineData data;

	data.name = m_parameters.name;
	data.status = get_status();
	data.type = EPilelineType::MAIN;

	data.width = m_probe.ready() ? m_probe.width : 0;
	data.height = m_probe.ready() ? m_probe.height : 0;
	data.fps = m_probe.ready() ? 25 : 0;
	data.codec = m_probe.ready() ? m_probe.codec_name : "";

	data.rtsp_url = m_parameters.rtsp_url;
	data.use_udp = m_parameters.use_udp;
	data.reconnect_time = m_parameters.reconnect_delay;
	data.latency = m_parameters.latency;

	data.record_path = m_parameters.record_path;
	data.segment_length = m_parameters.segment_length;

	return data;
}

EPilelineType UCameraMainPipeline::get_type() {
	return EPilelineType::MAIN;
}

