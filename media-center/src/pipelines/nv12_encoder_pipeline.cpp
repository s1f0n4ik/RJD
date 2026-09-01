#include "video_pipeline.h"
#include "signaling_definers.h"

#define VIRTUAL_TEE "virtual_tee"

UNV12EncodingPipeline::~UNV12EncodingPipeline() {

}

bool UNV12EncodingPipeline::initialize() {
	if (m_has_initialized == true) {
		return true;
	}

	if (!m_is_set) {
		if (m_logger) m_logger->error("initialize(): failed, parameters for streaming didn't set");
		return false;
	}

	// пропуск probe, здесь не нужен. Выставляем вручную
	m_probe.codec_name = "H264";
	m_probe.width = m_width;
	m_probe.height = m_height;
	m_probe.got_codec = true;
	m_probe.got_video_info = true;

	m_pipeline = gst_pipeline_new(m_parameters.name.c_str());

	m_bus_watch = setup_bus_watch(m_pipeline, false);

	auto appsrc = gst_element_factory_make("appsrc", "appsrc");
	auto src_queue = gst_element_factory_make("queue", "src_queue");
	auto convert = gst_element_factory_make("videoconvert", "convert");
	auto encoder = gst_element_factory_make("mpph264enc", "encoder");
	auto parse = gst_element_factory_make("h264parse", "parse");
	auto pay = gst_element_factory_make("rtph264pay", "pay");
	auto tee_queue = gst_element_factory_make("queue", "tee_queue");
	auto tee = gst_element_factory_make("tee", VIRTUAL_TEE);
	auto fake_q = gst_element_factory_make("queue", "fake_queue");
	auto fakesink = gst_element_factory_make("fakesink", "fake");

	auto clean_up = [&]() {
		if (m_pipeline) { gst_object_unref(m_pipeline); m_pipeline = nullptr; }
		for (auto* e : { appsrc, src_queue, convert, encoder,parse, pay, tee_queue, tee, fake_q, fakesink }) {
			if (e) gst_object_unref(e);
		}
		};

	if (!m_pipeline || !appsrc || !src_queue || !convert || !encoder
		|| !parse || !pay || !tee_queue || !tee || !fake_q || !fakesink) {
		m_logger->error("initialize(): failed to create one or more GStreamer elements");
		clean_up();
		return false;
	}

	// Капс, который фильтрует приходящее в appsrc
	std::string caps_str =
		"video/x-raw,format=RGBA"
		",width=" + std::to_string(m_width) +
		",height=" + std::to_string(m_height) +
		",framerate=" + std::to_string(m_fps) + "/1";

	GstCaps* caps = gst_caps_from_string(caps_str.c_str());
	g_object_set(appsrc,
		"caps", caps,
		"is-live", TRUE,
		"do-timestamp", TRUE,
		"format", GST_FORMAT_TIME,
		//"block", FALSE,
		//"max-bytes", (guint64)(m_width * m_height * 4), // 1 кадр
		//"leaky-type", 1,  // дроп кадров
		nullptr);
	gst_caps_unref(caps);

	g_object_set(encoder,
		"gop", m_fps, // ключевой кадр каждую секунду
		"level", 31,
		"profile", 66,
		nullptr);

	g_object_set(parse, "config-interval", 1, nullptr);
	g_object_set(pay, "config-interval", 1, "pt", 96, nullptr);

	// Очередь после декодера
	g_object_set(src_queue,
		"max-size-buffers", 2,
		"max-size-bytes", 0,
		"max-size-time", 0,
		"leaky", 2,  // дроп
		nullptr);

	g_object_set(tee_queue,
		"max-size-buffers", 0,
		"max-size-bytes", 0,
		"max-size-time", 0,
		nullptr);

	// Дроп, чтобы не было тормозов
	g_object_set(fake_q,
		"max-size-buffers", 1,
		"leaky", 2,
		nullptr);

	g_object_set(fakesink, "sync", FALSE, nullptr);

	gst_bin_add_many(GST_BIN(m_pipeline), appsrc, src_queue, convert, encoder,
		parse, pay, tee_queue, tee, fake_q, fakesink,
		nullptr);

	if (!gst_element_link_many(appsrc, src_queue, convert, encoder,
		parse, pay, tee_queue, tee, nullptr)) {
		m_logger->error("initialize(): failed to link main chain");
		clean_up();
		return false;
	}

	GstPad* tee_pad = gst_element_request_pad_simple(tee, "src_%u");
	GstPad* fake_pad = gst_element_get_static_pad(fake_q, "sink");
	if (gst_pad_link(tee_pad, fake_pad) != GST_PAD_LINK_OK) {
		m_logger->error("initialize(): failed to link tee → fake_queue");
		gst_object_unref(tee_pad);
		gst_object_unref(fake_pad);
		clean_up();
		return false;
	}
	gst_object_unref(tee_pad);
	gst_object_unref(fake_pad);

	if (!gst_element_link(fake_q, fakesink)) {
		m_logger->error("initialize(): failed to link fake_queue → fakesink");
		clean_up();
		return false;
	}

	m_appsrc = appsrc;  // pipeline владеет элементом, просто держим указатель
	m_tees.try_emplace(std::string(VIRTUAL_TEE), tee);

	m_has_initialized = true;
	m_logger->info("initialize(): virtual pipeline successfully initialized");
	return true;
}

void UNV12EncodingPipeline::on_bus_error(int code, const std::string& description, bool probe_handler) {
	broadcast_error(code, description);
	if (!probe_handler) shedule_restart();
}

void UNV12EncodingPipeline::on_bus_message(GstMessage* msg) {
	// без специфики
	return;
}

bool UNV12EncodingPipeline::teardown_prefix() {
	{
		std::lock_guard<std::mutex> lock(m_appsrc_mutex);
		m_is_set = false;
		m_appsrc = nullptr;
		m_frame_count = 0;
	}
	return true;
}

bool UNV12EncodingPipeline::create_webrtc_session(const std::string& client_id, std::string& description, int& code) {
	if (!UCameraPipeline::create_webrtc_session(client_id, description, code)) {
		return false;
	}

	auto remove_callback = [this](const std::string& client_id, std::string& description) {
		int close_code = 0;
		return this->close_webrtc_session(client_id, description, close_code);
		};

	auto session = std::make_unique<UWebRTCSession>(
		client_id,
		m_parameters.camera_name,
		true,
		m_pipeline,
		m_tees[std::string(VIRTUAL_TEE)],
		m_send_callback,
		remove_callback,
		m_logger.get()
	);

	if (!session) {
		description = "Error creation new session!";
		code = varan::signaling::CODE_SESSION_CREATE_FAILED;
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
		code = varan::signaling::CODE_SESSION_PIPELINE;
	}
	return ret;
}

void UNV12EncodingPipeline::set_stream_size(int width, int height, int fps) {
	// Выравниваем здесь, а не у вызывающих: размер приходит из трёх мест
	const int aligned_w = varan::align_frame_side(width);
	const int aligned_h = varan::align_frame_side(height);

	if ((aligned_w != width || aligned_h != height) && m_logger) {
		m_logger->warn("set_stream_size(): " + std::to_string(width) + "x" + std::to_string(height) +
			" aligned to " + std::to_string(aligned_w) + "x" + std::to_string(aligned_h));
	}

	m_width = aligned_w;
	m_height = aligned_h;
	m_src_width = width;
	m_src_height = height;
	m_fps = fps;
	m_is_set = true;
}

void UNV12EncodingPipeline::push_frame(cv::Mat frame) {
	if (!m_appsrc) return;

	if (!m_is_playing) {
		if (m_logger) m_logger->trace("push_frame(): not playing, skip frame");
		return;
	}

	if (frame.empty() && m_cached_frame.empty()) {
		if (m_logger) m_logger->trace("push_frame(): neither cached frame nor incoming frame, nothing to push");
		return;
	}
	auto& ref_frame = frame.empty() ? m_cached_frame : frame;

	// Невыровненный кадр кладём в угол выровненного буфера, остаток чёрный
	const bool exact = ref_frame.cols == m_width && ref_frame.rows == m_height;
	const bool paddable = ref_frame.cols == m_src_width && ref_frame.rows == m_src_height
		&& ref_frame.cols <= m_width && ref_frame.rows <= m_height;

	if (!exact && !paddable) {
		if (m_logger) m_logger->trace("push_frame(): frame size doesn't match the stream size");
		return;
	}

	const size_t buf_size = static_cast<size_t>(m_width) * m_height * 4;
	GstBuffer* buffer = gst_buffer_new_allocate(nullptr, buf_size, nullptr);
	if (!buffer) {
		if (m_logger) m_logger->error("push_frame(): Failed to allocate GstBuffer");
		return;
	}

	GstMapInfo map;
	if (!gst_buffer_map(buffer, &map, GST_MAP_WRITE)) {
		if (m_logger) m_logger->error("push_frame(): Failed to map GstBuffer");
		gst_buffer_unref(buffer);
		return;
	}

	// Просто копируем — frame уже RGBA из glReadPixels
	if (exact) {
		std::memcpy(map.data, ref_frame.data, buf_size);
	}
	else {
		std::memset(map.data, 0, buf_size);
		const size_t dst_stride = static_cast<size_t>(m_width) * 4;
		const size_t src_stride = static_cast<size_t>(ref_frame.cols) * 4;
		for (int y = 0; y < ref_frame.rows; ++y) {
			std::memcpy(map.data + y * dst_stride, ref_frame.ptr(y), src_stride);
		}
	}
	gst_buffer_unmap(buffer, &map);

	// Явный шаг строки, иначе элементы ниже считают его сами
	gst_buffer_add_video_meta(
		buffer,
		GST_VIDEO_FRAME_FLAG_NONE,
		GST_VIDEO_FORMAT_RGBA,
		static_cast<guint>(m_width),
		static_cast<guint>(m_height)
	);

	// Прописываем pts, чтобы не ломался поток
	//const GstClockTime pts = gst_util_uint64_scale(m_frame_count, GST_SECOND, m_fps);
	//const GstClockTime duration = gst_util_uint64_scale(1, GST_SECOND, m_fps);
	//GST_BUFFER_PTS(buffer) = pts;
	//GST_BUFFER_DTS(buffer) = pts;
	//GST_BUFFER_DURATION(buffer) = duration;
	//++m_frame_count;

	GstFlowReturn flow = gst_app_src_push_buffer(GST_APP_SRC(m_appsrc), buffer);
	if (flow != GST_FLOW_OK) {
		if (m_logger) m_logger->warn("push_frame(): push_buffer failed, flow=" + std::to_string(flow));
		if (flow == GST_FLOW_FLUSHING || flow == GST_FLOW_EOS) {
			m_frame_count = 0;
		}
	}
	else {
		//if (m_logger) m_logger->trace("push_frame(): Frame pushed successfully");
	}

	// Кешируем кадр
	{
		std::unique_lock<std::mutex> lock(m_cached_mutex);
		m_cached_frame = std::move(frame);
	}
}

std::optional<cv::Mat> UNV12EncodingPipeline::get_cached_frame() {
	std::unique_lock<std::mutex> lock(m_cached_mutex);
	if (m_cached_frame.empty()) {
		return std::nullopt;
	}
	else {
		auto copy_cached = m_cached_frame.clone();
		return std::move(copy_cached);
	}
}

FPipelineData UNV12EncodingPipeline::get_pipeline_data() {
	FPipelineData data;

	data.name = m_parameters.name;
	data.status = get_status();
	data.type = EPilelineType::NV12_ENCODER;

	data.width = m_probe.ready() ? m_probe.width : 0;
	data.height = m_probe.ready() ? m_probe.height : 0;
	data.fps = m_probe.ready() ? m_fps : 0;
	data.codec = m_probe.ready() ? m_probe.codec_name : "";

	data.rtsp_url = "";
	data.use_udp = "";
	data.reconnect_time = m_parameters.reconnect_delay;
	data.latency = m_parameters.latency;

	data.record_path = "";
	data.segment_length = -1;

	// Труба собирается из кадров, а не из потока камеры
	data.channel = 0;
	data.substream = 0;

	return data;
}

EPilelineType UNV12EncodingPipeline::get_type() {
	return EPilelineType::NV12_ENCODER;
}