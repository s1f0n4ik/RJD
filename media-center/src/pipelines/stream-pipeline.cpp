#include "video_pipeline.h"
#include "signaling_definers.h"
#include <filesystem>

#include <gst/rtsp/gstrtsptransport.h>

#include <gst/video/video.h>
#include <gst/video/gstvideometa.h>
#include <gst/allocators/gstdmabuf.h>
#include <gst/gl/gstglmemory.h>

#include "video_utility.h"
#include "utility/json-definers.h"
#include "utility/branch-helpers.h"
#include "nvr/element-definers.h"

#define MAIN_TEE "tee_main"

using namespace varan;

UCameraStreamPipeline::UCameraStreamPipeline(
	const FPipelineConfig& parameters,
	std::unique_ptr<ULogger> logger,
	std::function<void(std::string)> send_callback,
	varan::birdview::UEGLContextManager* gl_context_manager,
	CFrameMover dma_callback
)
	: UCameraPipeline(parameters, std::move(logger), send_callback)
	, m_dma_sender(std::move(dma_callback))
	, m_record_branch(FPipelineBranch(EBranchType::RECORD, "record"))
	, m_decoder_branch(FPipelineBranch(EBranchType::DECODER, "decoder"))
{
	create_gst_gl_context(gl_context_manager);
}

UCameraStreamPipeline::~UCameraStreamPipeline() {
	//teardown();
	if (m_timer_check_record_id != 0) {
		g_source_remove(m_timer_check_record_id);
		m_timer_check_record_id = 0;
	}

	m_send_callback = nullptr;
	m_dma_sender = nullptr;
	destroy_gst_gl_context();
}

bool UCameraStreamPipeline::teardown_prefix() {
	if (!destroy_branch(m_record_branch)) {
		m_logger->warn("teardown(): record branch didn't teardown properly!");
	}

	if (!destroy_branch(m_decoder_branch)) {
		m_logger->warn("teardown(): decoder branch didn't teardown properly!");
	}

	return true;
}

bool UCameraStreamPipeline::initialize() {
	if (m_has_initialized) {
		return true;
	}

	if (!UCameraPipeline::initialize()) {
		return false;
	}

	// Создание основного пайплайна
	m_pipeline = gst_pipeline_new(m_parameters.name.c_str());

	// Привязываем рестарт к пайплайну
	m_bus_watch = setup_bus_watch(m_pipeline, false);

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

	// Развязка приёмного потока rtspsrc и веток tee
	auto input_queue = gst_element_factory_make("queue", "input_queue");
	auto tee = gst_element_factory_make("tee", MAIN_TEE);
	auto fake_queue = gst_element_factory_make("queue", "sink_queue");
	auto fakesink = gst_element_factory_make("fakesink", "sink");

	auto clean_up = [&]() {
		if (m_pipeline) gst_object_unref(m_pipeline);
		if (src) gst_object_unref(src);
		if (depay) gst_object_unref(depay);
		if (parse) gst_object_unref(parse);
		if (input_queue) gst_object_unref(input_queue);
		if (tee) gst_object_unref(tee);
		if (fake_queue) gst_object_unref(fake_queue);
		if (fakesink) gst_object_unref(fakesink);
		};

	if (!m_pipeline || !src || !depay || !parse || !input_queue || !tee || !fake_queue || !fakesink) {
		std::ostringstream oss;
		oss << "Failed to create elements at reading pipeline: "
			<< "\n\tpipeline=" << (m_pipeline ? "OK" : "NULL") << ","
			<< "\n\tsrc=" << (src ? "OK" : "NULL") << ","
			<< "\n\tdepay=" << (depay ? "OK" : "NULL") << ","
			<< "\n\tparse=" << (parse ? "OK" : "NULL") << ","
			<< "\n\tinput_queue=" << (input_queue ? "OK" : "NULL") << ","
			<< "\n\ttee=" << (tee ? "OK" : "NULL") << ","
			<< "\n\tfake_queue=" << (fake_queue ? "OK" : "NULL") << ","
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

	// Развязка, а не буфер: запас три кадра, лишнее отбрасывается
	g_object_set(input_queue,
		"max-size-buffers", 3,
		"max-size-bytes", 0,
		"max-size-time", (guint64)0,
		"leaky", 2,
		"silent", TRUE,
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
		src, depay, parse, input_queue, tee, fake_queue, fakesink, nullptr
	);

	auto fail = [&](const std::string& m) {
		m_logger->error(m);
		if (m_pipeline) {
			gst_element_set_state(m_pipeline, GST_STATE_NULL);
			gst_object_unref(m_pipeline); m_pipeline = nullptr;
		}
		return false;
	};

	// Связывание основного потока
	if (!gst_element_link_many(depay, parse, input_queue, tee, nullptr)) {
		return fail("error link depay/parse/input_queue/tee");
	}

	// Связывание ветки с декодером
	// Связывание tee с decoding_queue
	GstPad* tee_pad = gst_element_request_pad_simple(tee, "src_%u");
	GstPad* queue_pad = gst_element_get_static_pad(fake_queue, "sink");

	if (gst_pad_link(tee_pad, queue_pad) != GST_PAD_LINK_OK) {
		return fail("error with pad link: tee_pad/queue_pad");
	}
	gst_object_unref(queue_pad);

	if (!gst_element_link_many(fake_queue, fakesink, nullptr)) {
		return fail("error with link: fake_queue, fakesink");
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

	// Ветка записи — по назначению record
	if (m_parameters.purposes.record) {
		if (m_parameters.record_path.empty() || m_parameters.segment_length <= 0) {
			m_logger->debug("inititalize(): record path not found. Record branch didn't create");
		}
		else {
			// Подпапка потока: у камеры может писаться несколько потоков сразу
			m_record_path = m_parameters.record_path / m_parameters.camera_name / m_parameters.name;
			create_record_branch(tee);
			set_timer_check_record_branch();
		}
	}
	else {
		if (m_logger) m_logger->debug("inititalize(): recording didn't specify, skip");
	}

	// Ветка декода — только если кадры кто-то забирает
	if (m_parameters.purposes.needs_decode()) {
		if (m_dma_sender) {
			create_decoder_branch(tee);
		}
		else {
			m_logger->error("inititalize(): purposes need frames, but dmabuf mover callback not found. Decoder branch didn't create");
		}
	}
	else {
		m_logger->debug("inititalize(): no frame consumers, decoder branch skipped");
	}

	m_tees[tee_str] = tee;

	m_has_initialized = true;
	m_logger->info("Pipeline for stream " + m_parameters.name
		+ " successfully created, purposes: " + m_parameters.purposes.to_string());

	return true;
}

void UCameraStreamPipeline::on_bus_error(int code, const std::string& description, bool probe_handler) {
	broadcast_error(code, description);
	if (!probe_handler) shedule_restart();
}

void UCameraStreamPipeline::on_bus_message(GstMessage* msg) {
	switch (GST_MESSAGE_TYPE(msg)) {
	case GST_MESSAGE_NEED_CONTEXT: {
		const gchar* type = nullptr;
		gst_message_parse_context_type(msg, &type);
		GstElement* element = GST_ELEMENT(msg->src);

		if (g_strcmp0(type, GST_GL_DISPLAY_CONTEXT_TYPE) == 0 && m_gl_context.display) {
			gst_element_set_context(element, m_gl_context.display);
		}
		else if (g_strcmp0(type, "gst.gl.app_context") == 0 && m_gl_context.app) {
			gst_element_set_context(element, m_gl_context.app);
		}
		break;
	}
	case GST_MESSAGE_ERROR: {
		// Специфика main: проверяем splitmux
		GError* err = nullptr;
		gchar* debug = nullptr;
		gst_message_parse_error(msg, &err, &debug);

		if (m_record_branch.is_deployed.load() &&
			(GST_MESSAGE_SRC(msg) == GST_OBJECT(
				m_record_branch.get_element(varan::nvr::RECORD_SPLITMUXSINK))))
		{
			m_logger->error("splitmux error, restarting record branch");
			destroy_branch(m_record_branch);
			create_record_branch(m_tees[MAIN_TEE]);
		}

		if (err) g_error_free(err);
		if (debug) g_free(debug);
		break;
	}
	default:
		break;
	}
}

bool UCameraStreamPipeline::create_decoder_branch(GstElement* tee) {
	if (!m_probe.ready()) {
		m_logger->error("create_decoder_branch(): cannot create decoder branch probe doesn't ready!");
		return false;
	}

	if (m_decoder_branch.is_deployed) {
		m_logger->warn("create_decoder_branch(): trying to create decode branch that already exists!");
		return true;
	}

	m_logger->debug("Creating branch to decode frames");

	auto queue = gst_element_factory_make("queue", varan::nvr::QUEUE.c_str());
	auto decoder = gst_element_factory_make("mppvideodec", varan::nvr::DECODER_MPPVIDEODEC.c_str());
	auto upload = gst_element_factory_make("glupload", varan::nvr::DECODER_GLUPLOAD.c_str());
	//auto colorconvert = gst_element_factory_make("glcolorconvert", varan::nvr::DECODER_GLCOLORCONVERT.c_str());
	auto appsink = gst_element_factory_make("appsink", varan::nvr::DECODER_APPSINK.c_str());

	if (!queue || !decoder || !upload || !appsink) {
		std::ostringstream oss;
		oss << "Failed to create elements at decode tee: "
			<< "\n\rdecode_queue=" << (queue ? "OK" : "NULL") << ","
			<< "\n\tmppvideodec=" << (decoder ? "OK" : "NULL") << ","
			//<< "\n\tglupload=" << (upload ? "OK" : "NULL") << ","
			//<< "\n\tglcolorconvert=" << (colorconvert ? "OK" : "NULL") << ","
			<< "\n\tappsink=" << (appsink ? "OK" : "NULL");
		m_logger->error(oss.str());
		return false;
	}

	g_object_set(queue,
		"max-size-buffers", 0,
		"leaky", 0,
		nullptr
	);

	g_object_set(decoder,
		"dma-feature", true,
		"discard-corrupted-frames", true,
		"fast-mode", false,
		"format", 23, // NV12
		nullptr
	);

	g_object_set(appsink,
		"emit-signals", TRUE,
		"sync", FALSE,
		"max-buffers", 1,
		"drop", TRUE,
		nullptr
	);

	gst_bin_add_many(GST_BIN(m_pipeline),
		queue, decoder, upload, appsink, nullptr
	);

	m_decoder_branch.tee_pad = gst_element_request_pad_simple(tee, "src_%u");
	GstPad* queue_pad = gst_element_get_static_pad(queue, "sink");
	if (gst_pad_link(m_decoder_branch.tee_pad, queue_pad) != GST_PAD_LINK_OK) {
		m_logger->error("Failed to link tee pad with decode branch!");
		gst_object_unref(queue_pad);
		return false;
	}
	gst_object_unref(queue_pad);

	g_signal_connect(
		appsink,
		"new-sample",
		G_CALLBACK(UCameraStreamPipeline::on_new_sample_gl_texture),
		this
	);

	if (!gst_element_link_many(queue, decoder, upload, appsink, nullptr)) {
		m_logger->error("Failed to link decoding elements in decode branch!");
		return false;
	}

	if (m_decoder_branch.elements.size() != 0) m_decoder_branch.elements.clear();

	m_decoder_branch.add_element(varan::nvr::QUEUE, queue);
	m_decoder_branch.add_element(varan::nvr::DECODER_MPPVIDEODEC, decoder);
	m_decoder_branch.add_element(varan::nvr::DECODER_GLUPLOAD, upload);
	//m_decoder_branch.add_element(varan::nvr::DECODER_GLCOLORCONVERT, colorconvert);
	m_decoder_branch.add_element(varan::nvr::DECODER_APPSINK, appsink);

	m_decoder_branch.is_deployed = true;
	m_decoder_branch.type = EBranchType::DECODER;

	// Использовать контекст GLES, если он был иницилизирован
	if (m_gl_context.is_initialized) {
		gst_element_set_context(m_pipeline, m_gl_context.display);
		gst_element_set_context(m_pipeline, m_gl_context.app);
		if (m_logger) m_logger->info("inititalize(): gstreamer opengl context initialized");
	}

	return false;
}

bool UCameraStreamPipeline::create_record_branch(GstElement* tee)
{
	if (!m_probe.ready()) {
		m_logger->error("create_record_branch(): cannot create record branch probe doesn't ready!");
		return false;
	}

	if (m_record_branch.is_deployed.load()) {
		m_logger->warn("create_record_branch(): trying to create record branch that already exists!");
		return true;
	}

	m_logger->debug("Creating branch to record segments...");
	if (!std::filesystem::exists(m_record_path)) {
		try {
			std::filesystem::create_directories(m_record_path);
			m_logger->debug("create_record_branch(): Directory " + m_record_path.string() + " sucessfully created!");
		}
		catch (...) {
			m_logger->error("create_record_branch(): Cannot create directories at path: " + m_record_path.string());
			return false;
		}
	}

	auto usage = get_disk_usage(m_parameters.record_path, m_logger.get());
	if (usage >= 95.0f) {
		m_logger->error("create_record_branch(): Cannot create record branch at path=" + m_record_path.string() + "; disk usage=" + std::to_string(usage));
		return false;
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
			auto self = static_cast<UCameraStreamPipeline*>(data);
			const auto& record_path = self->m_record_path;

			float usage = self->get_disk_usage(record_path, self->m_logger.get());
			if (usage >= 95.0f) {
				self->m_logger->warn(
					"format-location: disk usage " +
					std::to_string(static_cast<int>(usage)) +
					"%, scheduling record branch removal"
				);
				// Планируем удаление в главном потоке GLib — не трогаем пайплайн из колбека
				g_idle_add([](gpointer data) -> gboolean {
					auto self = static_cast<UCameraStreamPipeline*>(data);
					self->destroy_branch(self->m_record_branch);
					return G_SOURCE_REMOVE;
					}, self);

				// Возвращаем /dev/null чтобы не ронять splitmuxsink этим последним фрагментом
				return g_strdup("/dev/null");
			}

			// Генерация имени файла по времени
			std::ostringstream oss;
			oss << self->m_parameters.camera_name << "_" << make_start_timestamp() << ".mp4";

			auto save_path = record_path / oss.str();
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

	// Связывание элементов ветки
	if (!gst_element_link(record_queue, splitmux)) {
		if (m_logger) m_logger->error("Failed to link file record tee: tee, record_queue, splitmux");
		return false;
	}

	// Ветка запускается до подключения к tee: пуш в незапущенную даёт FLUSHING
	gst_element_sync_state_with_parent(record_queue);
	gst_element_sync_state_with_parent(splitmux);

	if (gst_element_get_state(record_queue, nullptr, nullptr, 2 * GST_SECOND) == GST_STATE_CHANGE_FAILURE) {
		m_logger->error("create_record_branch(): record queue didn't start");
		return false;
	}

	const auto attached = varan::core::attach_tee_pad(tee, record_queue);
	if (!attached.linked) {
		m_logger->error("Failed to link tee to record queue");
		if (attached.pad) {
			gst_element_release_request_pad(tee, attached.pad);
			gst_object_unref(attached.pad);
		}
		return false;
	}

	if (!attached.at_idle) {
		m_logger->warn("create_record_branch(): branch was linked without idle probe");
	}

	GstPad* tee_record_pad = attached.pad;

	if (m_record_branch.elements.size() != 0) m_record_branch.elements.clear();

	m_record_branch.add_element(varan::nvr::QUEUE, record_queue);
	m_record_branch.add_element(varan::nvr::RECORD_SPLITMUXSINK, splitmux);

	m_record_branch.tee_pad = tee_record_pad;

	m_record_branch.type = EBranchType::RECORD;
	m_record_branch.is_deployed.store(true);

	if (m_logger) m_logger->info("create_record_branch(): record branch successfully created!");

	return true;
}

void UCameraStreamPipeline::set_timer_check_record_branch() {
	m_timer_check_record_id = g_timeout_add_seconds(60, [](gpointer data) -> gboolean {
		auto self = static_cast<UCameraStreamPipeline*>(data);

		if (self->m_record_branch.is_deployed.load()) {
			if (self->m_logger) self->m_logger->debug("timer_check_record_branch: record branch is alive");
			return G_SOURCE_CONTINUE;
		}

		auto usage = UCameraStreamPipeline::get_disk_usage(self->m_record_path, self->m_logger.get());
		// Не восстанавливает, если заполненность диска больше 90 процентов
		if (usage >= 90.0f) {
			if (self->m_logger) self->m_logger->warn(
				"timer_check_record_branch: disk still at " +
				std::to_string(static_cast<int>(usage)) + "%, waiting, not recovering"
			);
			return G_SOURCE_CONTINUE;
		}

		self->m_logger->info(
			"timer_check_record_branch: disk at " +
			std::to_string(static_cast<int>(usage)) + "%, restoring record branch"
		);
		self->create_record_branch(self->m_tees[MAIN_TEE]);
		return G_SOURCE_CONTINUE;
	}, this);
}

bool UCameraStreamPipeline::destroy_branch(FPipelineBranch& branch)
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
		auto appsink = branch.get_element(varan::nvr::DECODER_APPSINK);
		if (appsink) {
			g_signal_handlers_disconnect_by_data(appsink, this);
			m_logger->debug("destroy_branch(): disconnect signals from decoder element!");
		}
	}

	if (branch.tee_pad) {
		if (!varan::core::detach_tee_pad(m_tees[MAIN_TEE], branch.tee_pad,
				branch.get_element(varan::nvr::QUEUE))) {
			m_logger->warn("destroy_branch(): " + branch.name
				+ " branch was detached without idle probe");
		}

		gst_object_unref(branch.tee_pad);
		m_logger->debug("destroy_branch(): relese request tee pad from main pipeline!");
		branch.tee_pad = nullptr;
	}

	if (branch.type == EBranchType::RECORD) {
		auto splitmux = branch.get_element(varan::nvr::RECORD_SPLITMUXSINK);
		if (splitmux) {
			g_signal_emit_by_name(branch.get_element(varan::nvr::RECORD_SPLITMUXSINK), "split-now");
		}
	}

	// Остановка элементов
	for (auto& pair_element : branch.elements) {
		auto element_name = pair_element.first;
		auto element = pair_element.second;

		if (!element) {
			if (m_logger) m_logger->warn("destroy_branch(): cannot delete NULL element " + element_name);
			continue;
		}
		if (m_logger) m_logger->debug("destroy_branch(): turn to NULL state element " + element_name);
		gst_element_set_state(element, GST_STATE_NULL);
		GstStateChangeReturn ret = gst_element_get_state(element, nullptr, nullptr, 3 * GST_SECOND);
		if (ret == GST_STATE_CHANGE_FAILURE) {
			if (m_logger) m_logger->error("destroy_branch(): failed to set NULL: " + element_name);
		}

		gst_bin_remove(GST_BIN(m_pipeline), element);
	}

	branch.elements.clear();

	branch.is_deployed.store(false);
	m_logger->info("destroy_branch(): " + branch.name + " branch was deleted!");
	return true;
}

bool UCameraStreamPipeline::create_webrtc_session(const std::string& client_id, std::string& description, int& code)
{
	std::string client = client_id;
	if (!UCameraPipeline::create_webrtc_session(client, description, code)) {
		return false;
	}

	auto session = std::make_unique<UWebRTCSession>(
		client,
		m_parameters.camera_name,
		false,
		m_pipeline,
		m_tees[std::string(MAIN_TEE)],
		m_send_callback,
		std::move(
			[this](const std::string& client, std::string& description) {
				int close_code = 0;
				return this->close_webrtc_session(client, description, close_code);
			}
		),
		m_logger.get()
	);

	if (!session) {
		description = "Unresolved error creation new session!";
		code = varan::signaling::CODE_SESSION_CREATE_FAILED;
		return false;
	}

	auto [it, inserted] = m_webrtc_sessions.emplace(client, std::move(session));

	auto ret = it->second->create_branch(m_probe.codec_name);
	if (ret) {
		m_logger->info("Successfully created webrtc session branch with client " + client);
		description = "Connection resolved!";
	}
	else {
		m_logger->info("Error creation webrtc session branch with client " + client);
		description = "Connection doesn't resolved!";
		code = varan::signaling::CODE_SESSION_PIPELINE;
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

GstFlowReturn UCameraStreamPipeline::on_new_sample_dma(GstElement* sink, gpointer user_data) {
	auto pipeline = static_cast<UCameraStreamPipeline*>(user_data);
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
		if (pipeline->m_logger) pipeline->m_logger->trace("on_new_sample_dma(): There is not buffer or caps!");
		gst_sample_unref(sample);
		return GST_FLOW_OK;
	}

	// Test
	gchar* caps_str = gst_caps_to_string(caps);
	if (caps_str) {
		if (pipeline->m_logger)
			pipeline->m_logger->debug(std::string("Caps: ") + caps_str);

		g_free(caps_str);
	}

	// Получение размера
	GstVideoInfo info;
	if (!gst_video_info_from_caps(&info, caps)) {
		if (pipeline->m_logger) pipeline->m_logger->debug("on_new_sample_dma(): There is no video info!");
		gst_sample_unref(sample);
		return GST_FLOW_OK;
	}

	auto frame = std::make_shared<UDmaFdFrame>();
	// Получние типа памяти
	guint n_mem = gst_buffer_n_memory(buffer);
	guint num_planes = info.finfo->n_planes;
	if (num_planes < n_mem) {
		if (pipeline->m_logger) pipeline->m_logger->error("on_new_sample_dma(): Count of memory buffers greater then frame planes!");
		gst_sample_unref(sample);
		return GST_FLOW_OK;
	}

	for (guint i = 0; i < n_mem; i++) {
		GstMemory* mem = gst_buffer_peek_memory(buffer, i);

		if (!gst_is_dmabuf_memory(mem)) {
			if (pipeline->m_logger) pipeline->m_logger->warn("on_new_sample_dma(): Got not a dmabuf memory!");
			continue;
		}

		int fd = dup(gst_dmabuf_memory_get_fd(mem));
		if (fd >= 0) {
			frame->fds.push_back(fd);
		}
	}

	if (frame->fds.size() == 0) {
		if (pipeline->m_logger) pipeline->m_logger->warn("on_new_sample_dma(): no one dmabuf fds, skip frame!");
		gst_sample_unref(sample);
		return GST_FLOW_OK;
	}

	// Получение данных по кадру
	frame->format = std::string(gst_video_format_to_string(info.finfo->format));
	frame->width = info.width;
	frame->height = info.height;
	frame->size = info.size;
	frame->pts = GST_BUFFER_PTS(buffer) / 1e6;
	// Берем данные plane
	for (guint i = 0; i < num_planes; i++) {
		UDmaFdFrame::FDmabufPlane plane;
		plane.stride = info.stride[i];
		plane.offset = info.offset[i];
		// Только для NV12
		if (frame->format == "NV12") {
			plane.height = (i == 0) ? info.height : info.height / 2;
		}
		else {
			plane.height = frame->height;
		}

		frame->planes.push_back(std::move(plane));
	}

	// Передаем буфер кадров
	if (pipeline->m_dma_sender) pipeline->m_dma_sender(pipeline->m_parameters.camera_name, std::move(frame));

	gst_sample_unref(sample);

	return GST_FLOW_OK;
}

GstFlowReturn UCameraStreamPipeline::on_new_sample_gl_texture(GstElement* sink, gpointer user_data) {
	auto pipeline = static_cast<UCameraStreamPipeline*>(user_data);
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
		if (pipeline->m_logger) pipeline->m_logger->trace("on_new_sample_gl_texture(): There is not buffer or caps!");
		gst_sample_unref(sample);
		return GST_FLOW_OK;
	}

	// Test
	/*gchar* caps_str = gst_caps_to_string(caps);
	if (caps_str) {
		if (pipeline->m_logger)
			pipeline->m_logger->debug(std::string("Caps: ") + caps_str);

		g_free(caps_str);
	}*/

	// Получение размера
	GstVideoInfo info;
	if (!gst_video_info_from_caps(&info, caps)) {
		if (pipeline->m_logger) pipeline->m_logger->debug("on_new_sample_gl_texture(): There is no video info!");
		gst_sample_unref(sample);
		return GST_FLOW_OK;
	}

	// Формировние фрейма
	auto gl_frame = std::make_shared<USharedGLTextureWrapper>(sample);
	guint n_mem = gst_buffer_n_memory(buffer);
	guint num_planes = info.finfo->n_planes;
	if (num_planes < n_mem) {
		if (pipeline->m_logger) pipeline->m_logger->error("on_new_sample_gl_texture(): Count of memory buffers greater then frame planes!");
		//gst_sample_unref(sample);
		return GST_FLOW_OK;
	}

	for (guint i = 0; i < n_mem; i++) {
		GstMemory* mem = gst_buffer_peek_memory(buffer, i);

		if (!gst_is_gl_memory(mem)) {
			if (pipeline->m_logger) pipeline->m_logger->error("on_new_sample_gl_texture(): Got not an opengl memory!");
			//gst_sample_unref(sample);
			return GST_FLOW_OK;
		}
		// создание одной текстуры
		USharedGLTextureWrapper::FGLTexture gl_texture;
		GstGLMemory* gl_mem = (GstGLMemory*)mem;

		gl_texture.id = gst_gl_memory_get_texture_id(gl_mem);
		gl_texture.width = gst_gl_memory_get_texture_width(gl_mem);
		gl_texture.height = gst_gl_memory_get_texture_height(gl_mem);
		gl_texture.format = USharedGLTextureWrapper::from_gst_to_gl_format(gst_gl_memory_get_texture_format(gl_mem));
		gl_texture.target = USharedGLTextureWrapper::from_gst_to_gl_target(gst_gl_memory_get_texture_target(gl_mem));

		gl_frame->add_texture(std::move(gl_texture));
	}

	// Получение данных по кадру
	gl_frame->format = std::string(gst_video_format_to_string(info.finfo->format));
	gl_frame->width = info.width;
	gl_frame->height = info.height;
	gl_frame->pts = GST_BUFFER_PTS(buffer) / 1e6;

	// Передаем буфер кадров
	if (pipeline->m_dma_sender) pipeline->m_dma_sender(pipeline->m_parameters.camera_name, std::move(gl_frame));

	gst_sample_unref(sample);

	return GST_FLOW_OK;
}

void UCameraStreamPipeline::create_gst_gl_context(varan::birdview::UEGLContextManager* gl_context_manager) {
	if (!gl_context_manager) {
		if (m_logger) m_logger->warn(
			(std::ostringstream() << "create_gst_gl_context(): cannot create GStreamer OpenGL context: context manadger is NULL!").str()
		);
		return;
	}

	if (m_gl_context.is_initialized) {
		if (m_logger) m_logger->warn("create_gst_gl_context(): cannot create already initialized GStreamer GL context!");
		return;
	}

	GstGLDisplay* gst_display = nullptr;
	GstGLContext* gst_ctx = nullptr;
	GstContext* display_ctx = nullptr;
	GstContext* app_ctx = nullptr;

	auto clean_context = [&]() {
		if (gst_ctx) gst_object_unref(gst_ctx);
		if (gst_display) gst_object_unref(gst_display);
		destroy_gst_gl_context();
		};

	// Общий контекст
	m_gl_context.root_display = gl_context_manager->get_display();
	if (!gl_context_manager->create_shared_context(m_gl_context.shared_context, m_logger.get())) {
		if (m_logger) m_logger->error("create_gst_gl_context(): fault with creation shared context!");
		m_gl_context.root_display = EGL_NO_DISPLAY;
		return;
	}
	// Обертка для Gstreamer
	gst_display = GST_GL_DISPLAY(gst_gl_display_egl_new_with_egl_display(gl_context_manager->get_display()));
	if (!gst_display) {
		if (m_logger) m_logger->error("create_gst_gl_context(): cannot create gst gl display from shared context!");
		clean_context();
		return;
	}

	gst_ctx = gst_gl_context_new_wrapped(
		gst_display,
		(guintptr)m_gl_context.shared_context.context,
		GST_GL_PLATFORM_EGL,
		GST_GL_API_GLES2
	);
	if (!gst_ctx) {
		if (m_logger) m_logger->error("create_gst_gl_context(): cannot create gst wrapped context with shared gl context!");
		clean_context();
		return;
	}

	display_ctx = gst_context_new(GST_GL_DISPLAY_CONTEXT_TYPE, TRUE);
	if (!display_ctx) {
		if (m_logger) m_logger->error("create_gst_gl_context(): cannot create gst display context with shared gl context!");
		clean_context();
		return;
	}
	gst_context_set_gl_display(display_ctx, gst_display);

	app_ctx = gst_context_new("gst.gl.app_context", TRUE);
	if (!app_ctx) {
		if (m_logger) m_logger->error("create_gst_gl_context(): cannot create gst app context with shared gl context!");
		clean_context();
		return;
	}
	gst_structure_set(
		gst_context_writable_structure(app_ctx),
		"context", GST_TYPE_GL_CONTEXT, gst_ctx,
		NULL
	);

	m_gl_context.app = gst_context_ref(app_ctx);
	m_gl_context.display = gst_context_ref(display_ctx);
	m_gl_context.is_initialized = true;
}

void UCameraStreamPipeline::destroy_gst_gl_context() {
	if (m_gl_context.app) {
		gst_context_unref(m_gl_context.app);
		m_gl_context.app = nullptr;
	}

	if (m_gl_context.display) {
		gst_context_unref(m_gl_context.display);
		m_gl_context.display = nullptr;
	}

	if (m_gl_context.root_display != EGL_NO_DISPLAY && m_gl_context.shared_context.context != EGL_NO_CONTEXT) {
		eglDestroyContext(m_gl_context.root_display, m_gl_context.shared_context.context);
	}
	m_gl_context.root_display = EGL_NO_DISPLAY;

	memset(&m_gl_context.shared_context, 0, sizeof(m_gl_context.shared_context));
	m_gl_context.is_initialized = false;
	if (m_logger) m_logger->info("destroy_gst_gl_context(): destroyed");
}

float UCameraStreamPipeline::get_disk_usage(const std::string path, ULogger* logger) {
	std::error_code ec;
	auto space = std::filesystem::space(path, ec);
	if (ec || space.capacity == 0) {
		if (logger) logger->warn("get_disk_usage(): error with computing space at disk!");
		return 146.0f;
	}

	auto usage = static_cast<float>(space.capacity - space.available) / static_cast<float>(space.capacity) * 100.0f;
	if (logger) logger->debug("get_disk_usage(): current space usage is " + std::to_string(usage) + "; check from path " + path);
	return usage;
}

FPipelineData UCameraStreamPipeline::get_pipeline_data() {
	FPipelineData data;

	data.name = m_parameters.name;
	data.status = get_status();
	data.type = EPilelineType::CAMERA;
	data.purposes = m_parameters.purposes;

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

	data.channel = m_parameters.channel;
	data.substream = m_parameters.substream;

	return data;
}

EPilelineType UCameraStreamPipeline::get_type() {
	return EPilelineType::CAMERA;
}

