#include "camera.h"
#include <libavutil/hwcontext_drm.h>
#include <gst/gst.h>
#include <gst/allocators/allocators.h>
#include <gst/webrtc/webrtc.h>
#include <ranges>

#include "console_utility.h"
#include "video_utility.h"
#include "signaling_definers.h"

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

	UCamera::UCamera(const FCameraOptions& options) 
		: m_running(false)
		, m_error(false)
		, m_initialized(false)
		, m_gst_initialized(false)
		//, m_packets_buffer(options.buff_reading_size)
		, m_frames_buffer(options.buff_reading_size)
		, m_reading_pipeline(nullptr, &gst_object_unref)
		, m_webrtcbin_pipeline(nullptr, &gst_object_unref)
		, m_webrtcbin_appsrc(nullptr, &gst_object_unref)
		, m_webrtcbin_tee(nullptr, &gst_object_unref)
		, m_io_context()
		, m_work_guard(boost::asio::make_work_guard(m_io_context))
		, m_websocket_client(nullptr)
		, m_internal_options()
		, m_options(options)
	{

	};

	UCamera::~UCamera() { 
		stop(); 
		stop_websocket_client();
	}

	bool UCamera::initialize() {
		if (m_initialized) return true;

		try {
			m_initialized = true;
			return true;
		}
		catch (const std::runtime_error& error) {
			std::cerr << error.what();
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
		if (m_running) return false;
		m_running = true;

		//m_reading_thread = std::thread(&UCamera::read_frames, this, std::ref(m_mpeg_context));

		return true;
	}

	void UCamera::stop() {
		if (!m_running) return;
		m_running = false;

		if (m_reading_thread.joinable()) m_reading_thread.join();
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
	void UCamera::on_rtsp_pad_added(GstElement* element, GstPad* pad, gpointer data)
	{
		FInternalCameraOpts* info = static_cast<FInternalCameraOpts*>(data);

		GstCaps* caps = gst_pad_query_caps(pad, nullptr);
		if (!caps)
			return;

		GstStructure* s = gst_caps_get_structure(caps, 0);
		const gchar* media = gst_structure_get_string(s, "media");
		const gchar* encoding = gst_structure_get_string(s, "encoding-name");

		if (media && encoding && g_strcmp0(media, "video") == 0) {
			info->codec_name = encoding;
			g_print("[SDP] codec: %s\n", encoding);
		}

		gst_caps_unref(caps);
	}

	GstPadProbeReturn UCamera::on_parser_event(GstPad*, GstPadProbeInfo* probe_info, gpointer user_data)
	{
		if (!(GST_PAD_PROBE_INFO_TYPE(probe_info) & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM)) {
			return GST_PAD_PROBE_OK;
		}

		GstEvent* event = gst_pad_probe_info_get_event(probe_info);
		if (!event || GST_EVENT_TYPE(event) != GST_EVENT_CAPS) {
			return GST_PAD_PROBE_OK;
		}

		GstCaps* caps = nullptr;
		gst_event_parse_caps(event, &caps);
		if (!caps) {
			return GST_PAD_PROBE_OK;
		}

		FInternalCameraOpts* camera_options = static_cast<FInternalCameraOpts*>(user_data);

		GstStructure* s = gst_caps_get_structure(caps, 0);

		gst_structure_get_int(s, "width", &camera_options->width);
		gst_structure_get_int(s, "height", &camera_options->height);
		gst_structure_get_fraction(s, "framerate", &camera_options->framerate_num, &camera_options->framerate_den);

		const gchar* profile = gst_structure_get_string(s, "profile");
		if (profile) {
			camera_options->profile = profile;
		}

		if (camera_options->width && camera_options->height) {
			g_print("[CAPS] %dx%d @ %d/%d fps\n",
				camera_options->width, camera_options->height,
				camera_options->framerate_num, camera_options->framerate_den);
			camera_options->ready = true;
		}

		return GST_PAD_PROBE_OK;
	}

	bool UCamera::try_camera_probe(int timeout_sec, std::string& error_out)
	{
		error_out.clear();

		TUniqueGst pipeline = TUniqueGst(gst_pipeline_new(nullptr), &gst_object_unref);
		TUniqueGst src = TUniqueGst(gst_element_factory_make("rtspsrc", nullptr), &gst_object_unref);
		TUniqueGst sink = TUniqueGst(gst_element_factory_make("fakesink", nullptr), &gst_object_unref);

		auto cleanup = [&]() {
			if (pipeline) {
				gst_element_set_state(pipeline.get(), GST_STATE_NULL);
			}
		};

		if (!pipeline || !src || !sink) {
			error_out = "Failed to create GStreamer elements";
			cleanup();
			return false;
		}

		g_object_set(src.get(),
			"location", m_options.rtsp_url.c_str(),
			"latency", 0,
			"timeout", timeout_sec * GST_SECOND,
			nullptr
		);

		gst_bin_add_many(GST_BIN(pipeline.get()), src.get(), sink.get(), nullptr);
		g_signal_connect(src.get(), "pad-added", G_CALLBACK(on_rtsp_pad_added), &m_internal_options);

		gst_element_set_state(pipeline.get(), GST_STATE_PAUSED);

		TUniqueBus bus = TUniqueBus(gst_element_get_bus(pipeline.get()), &gst_object_unref);
		gint64 deadline = g_get_monotonic_time() + timeout_sec * G_TIME_SPAN_SECOND;

		/* ==== wait SDP ==== */
		while (m_internal_options.codec_name.empty() && g_get_monotonic_time() < deadline) {
			GstMessage* msg = gst_bus_timed_pop(bus.get(), 200 * GST_MSECOND);
			if (!msg) {
				continue;
			}

			if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
				GError* err;
				gchar* dbg;
				gst_message_parse_error(msg, &err, &dbg);
				error_out = err->message;
				g_error_free(err);
				g_free(dbg);
				gst_message_unref(msg);
				cleanup();
				return false;
			}
			gst_message_unref(msg);
		}

		if (m_internal_options.codec_name.empty()) {
			error_out = "SDP timeout (codec not detected)";
			cleanup();
			return false;
		}


		/* ==== depay + parser ==== */
		TUniqueGst depay = TUniqueGst(nullptr, &gst_object_unref);
		TUniqueGst parser = TUniqueGst(nullptr, &gst_object_unref);

		if (m_internal_options.codec_name == "H264") {
			depay.reset(
				gst_element_factory_make("rtph264depay", nullptr)
			);
			parser.reset(
				gst_element_factory_make("h264parse", nullptr)
			);
		}
		else if (m_internal_options.codec_name == "H265") {
			depay.reset(
				gst_element_factory_make("rtph265depay", nullptr)
			);
			parser.reset(
				gst_element_factory_make("h265parse", nullptr)
			);
		}
		else {
			error_out = "Unsupported codec: " + m_internal_options.codec_name;
			cleanup();
			return false;
		}

		if (!depay || !parser) {
			error_out = "Failed to create depay/parser";
			cleanup();
			return false;
		}

		gst_bin_add_many(GST_BIN(pipeline.get()), depay.get(), parser.get(), nullptr);
		if (!gst_element_link_many(depay.get(), parser.get(), sink.get(), nullptr)) {
			error_out = "Failed to link depay -> parser -> sink";
			cleanup();
			return false;
		}

		GstPad* parser_src = gst_element_get_static_pad(parser.get(), "src");
		gst_pad_add_probe(
			parser_src,
			GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM,
			on_parser_event,
			&m_internal_options,
			nullptr
		);
		gst_object_unref(parser_src);

		GstPad* depay_sink = gst_element_get_static_pad(depay.get(), "sink");
		g_signal_connect(
			src.get(), 
			"pad-added", 
			G_CALLBACK(+[](
				GstElement*, GstPad* pad, gpointer data) {
					gst_pad_link(pad, GST_PAD(data));
			}),
			depay_sink
		);

		gst_element_set_state(pipeline.get(), GST_STATE_PLAYING);

		/* ==== wait CAPS ==== */
		while (!m_internal_options.ready && g_get_monotonic_time() < deadline) {
			GstMessage* msg = gst_bus_timed_pop(bus.get(), 200 * GST_MSECOND);
			if (!msg) {
				continue;
			}

			if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
				GError* err;
				gchar* dbg;
				gst_message_parse_error(msg, &err, &dbg);
				error_out = err->message;
				g_error_free(err);
				g_free(dbg);
				gst_message_unref(msg);
				cleanup();
				return false;
			}
			gst_message_unref(msg);
		}

		if (!m_internal_options.ready) {
			error_out = "CAPS timeout (no resolution)";
			cleanup();
			return false;
		}

		cleanup();
		return true;
	}

	bool UCamera::probe_camera_with_reconnect(int attempts, int timeout_sec, int reconnect_delay_sec)
	{
		std::string error;

		for (int i = 1; i <= attempts; ++i) {
			std::cout << "[TRY " << i << "/" << attempts << "] connecting...\n";

			if (try_camera_probe(timeout_sec, error)) {
				std::cout << "[SUCCESS]\n";
				return true;
			}

			std::cerr << "[ERROR] " << error << "\n";

			if (i < attempts) {
				std::this_thread::sleep_for(
					std::chrono::seconds(reconnect_delay_sec));
			}
		}

		throw std::runtime_error("Camera unreachable after retries");
	}

	// ====================================
	//     GStreaming Получение кадров с камер
	// ====================================

	// ====================================
	//     GStreaming WebRtcBin
	// ====================================

	bool UCamera::create_gst_pipeline_webrtc()
	{
		if (m_gst_initialized) {
			return true;
		}

		gst_init(nullptr, nullptr);

		std::cout << color::yellow << "[UCamera] Creating gst streaming for camera " << m_options.name << "..." << color::reset << std::endl;

		std::ostringstream oss_error;
		if (!m_mpeg_context.codec_ctx) {
			oss_error << color::red << "[UCamera] Error in create_gst_pipeline_webrtc(): no initialized codec!" << color::reset << std::endl;
			throw std::runtime_error(oss_error.str());
		}

		std::string format = "NV12";
		switch (m_internal_options.format) {
		case AVPixelFormat::AV_PIX_FMT_NV12:
			format = "NV12";
			break;
		case AVPixelFormat::AV_PIX_FMT_NV21:
			format = "NV21";
			break;
		case AVPixelFormat::AV_PIX_FMT_RGB24:
			format = "RGB";
			break;
		case AVPixelFormat::AV_PIX_FMT_BGR24:
			format = "BGR";
			break;
		}
		int width = m_mpeg_context.codec_ctx->width;
		int height = m_mpeg_context.codec_ctx->height;

		auto codec_name = m_mpeg_context.codec_ctx->codec->name;
		std::string encoder, encoding_name, parse, pay;
		if (strcmp(codec_name, "h264_rkmpp") == 0) {
			encoder = "mpph264enc"; encoding_name = "H264"; parse = "h264parse"; pay = "rtph264pay";
		}
		else if (strcmp(codec_name, "hevc_rkmpp") == 0) {
			encoder = "mpph264enc"; encoding_name = "H264"; parse = "h264parse"; pay = "rtph264pay";
		}
		else {
			oss_error << color::red << "[UCamera] Error in create_gst_pipeline_webrtc(): an unsupported codec is being used: " << codec_name << "!" << color::reset << std::endl;
			throw std::runtime_error(oss_error.str());
		}
		
		m_webrtcbin_pipeline = TUniqueGst(gst_pipeline_new(("pipe_" + m_options.name).c_str()), &gst_object_unref);
		if (!m_webrtcbin_pipeline) {
			std::cerr << "Failed to create pipeline" << std::endl;
			return false;
		}

		// 2. Создаем элементы
		GstElement* appsrc = gst_element_factory_make("appsrc", ("src_" + m_options.name).c_str());
		//GstElement* convert = gst_element_factory_make("videoconvert", nullptr);
		GstElement* encoder_el = gst_element_factory_make(encoder.c_str(), nullptr);
		GstElement* parse_el = gst_element_factory_make(parse.c_str(), nullptr);
		GstElement* pay_el = gst_element_factory_make(pay.c_str(), nullptr);
		GstElement* tee = gst_element_factory_make("tee", ("tee_" + m_options.name).c_str());

		if (!appsrc || !encoder_el || !parse_el || !pay_el || !tee) {
			std::cerr << "Failed to create one of pipeline elements" << std::endl;
			return false;
		}

		// 3. Настройка appsrc
		g_object_set(appsrc,
			"is-live", TRUE,
			"format", GST_FORMAT_TIME,
			"do-timestamp", TRUE,
			NULL);

		// 4. Настройка encoder
		g_object_set(encoder_el,
			"profile", 66,
			"level", 31,
			"gop", -1,
			"min-force-key-unit-interval", (guint64)0,
			NULL);

		//g_object_set(parse_el,
		//	NULL);

		// 5. Настройка rtppay
		g_object_set(pay_el,
			"pt", 96,
			"config-interval", -1,
			NULL);

		// 6. Настройка caps: video/x-raw(memory:DMABuf)
		GstCaps* caps = gst_caps_new_full(
			gst_structure_new(
				"video/x-raw",
				"format", G_TYPE_STRING, format.c_str(),
				"drm-format", G_TYPE_UINT64, DRM_FORMAT_NV12,
				"width", G_TYPE_INT, width,
				"height", G_TYPE_INT, height,
				"framerate", GST_TYPE_FRACTION, m_options.framerate, 1,
				NULL),
			NULL);

		gst_caps_set_features(caps, 0, gst_caps_features_new("memory:DMABuf", NULL));

		g_object_set(appsrc, "caps", caps, NULL);

		// 7. Добавляем элементы в pipeline
		gst_bin_add_many(GST_BIN(m_webrtcbin_pipeline.get()),
			appsrc, encoder_el, parse_el, pay_el, tee,
			NULL);

		// 8. Линкуем
		if (!gst_element_link_filtered(appsrc, encoder_el, caps)) {
			std::cerr << "Failed to link appsrc -> convert with caps" << std::endl;
			gst_caps_unref(caps);
			return false;
		}

		gst_caps_unref(caps);

		//if (!gst_element_link(convert, encoder_el)) {
		//	std::cerr << "Failed to link convert -> encoder" << std::endl;
		//	return false;
		//}
		if (!gst_element_link(encoder_el, parse_el)) {
			std::cerr << "Failed to link encoder -> parse" << std::endl;
			return false;
		}
		if (!gst_element_link(parse_el, pay_el)) {
			std::cerr << "Failed to link parse -> pay" << std::endl;
			return false;
		}
		if (!gst_element_link(pay_el, tee)) {
			std::cerr << "Failed to link pay -> tee" << std::endl;
			return false;
		}

		// 9. Сохраняем объекты
		m_webrtcbin_appsrc = TUniqueGst(appsrc, &gst_object_unref);
		m_webrtcbin_tee = TUniqueGst(tee, &gst_object_unref);

		m_main_loop = g_main_loop_new(nullptr, FALSE);
		m_gst_loop_thread = std::thread([this]() {
			g_main_loop_run(m_main_loop);
		});

		std::cout << color::green << "[UCamera] Creation gst streaming for camera " << m_options.name << " was successful!" << color::reset << std::endl;

		m_gst_initialized = true;
		return m_gst_initialized;
	}

	void UCamera::push_frames_to_gst_pipeline()
	{
		if (!m_webrtcbin_appsrc) {
			std::ostringstream oss;
			oss << color::red << "[UCamera push_thread] No appsrc initis!" << color::reset << std::endl;
			throw std::runtime_error(oss.str());
		}

		GstAllocator* allocator = gst_dmabuf_allocator_new();

		while (m_running) {
			// Если нет откртых сессий - нет сысла в выполнении этого кода
			{
				std::unique_lock<std::mutex> lock(m_session_mutex);
				m_session_cv.wait(lock, [this] { return !m_running || m_has_sessions; });
				if (!m_running) break;
			}

			const auto frame = m_frames_buffer.wait_and_pop();

			if (frame->fd < 0) {
				std::cerr << color::red << "[UCamera " << m_options.name
					<< "] Push thread: invalid frame fd: " << frame->fd << color::reset << std::endl;
				continue;
			}

			GstBuffer* buffer = gst_buffer_new();
			if (!buffer) {
				std::this_thread::sleep_for(std::chrono::milliseconds(1));
				continue;
			}

			bool fail = false;
			// Предположим один fd, один план и offset == 0
			if (frame->num_planes == 1 && frame->offset[0] == 0) {
				int gst_fd = dup(frame->fd);
				if (gst_fd < 0) {
					gst_buffer_unref(buffer);
					continue;
				}

				size_t size = frame->pitch[0] * frame->height * 3 / 2;
				GstMemory* mem = gst_dmabuf_allocator_alloc(allocator, gst_fd, size);

				if (!mem) {
					close(gst_fd);
					gst_buffer_unref(buffer);
					continue;
				}
				gst_buffer_append_memory(buffer, mem);
			}
			else {
				// Несколько планов с offset — используем gst_memory_new_wrapped
				for (int i = 0; i < frame->num_planes; ++i) {
					size_t plane_size = frame->pitch[i] * frame->height;

					int gst_fd = dup(frame->fd);
					if (gst_fd < 0) {
						fail = true;
						break;
					}

					GstMemory* mem = gst_dmabuf_allocator_alloc(allocator, gst_fd, plane_size);

					if (!mem) {
						close(gst_fd);
						fail = true;
						continue;
					}

					gst_buffer_append_memory(buffer, mem);
				}
			}

			if (fail) {
				gst_buffer_unref(buffer);
				continue;
			}

			GST_BUFFER_PTS(buffer) = frame->pts;

			// проверка состояния потока
			/* {
				GstState current, pending;
				GstStateChangeReturn ret;
				ret = gst_element_get_state(m_pipeline.get(), &current, &pending, GST_CLOCK_TIME_NONE);
				if (!current || current != GST_STATE_PLAYING) {
					gst_buffer_unref(buffer);
					std::this_thread::sleep_for(std::chrono::microseconds(200));
					continue;
				}
			}*/

			if (m_has_sessions) {
				GstFlowReturn ret = gst_app_src_push_buffer(GST_APP_SRC(m_webrtcbin_appsrc.get()), buffer);

				if (ret != GST_FLOW_OK) {
					gst_buffer_unref(buffer);
				}
			}
			else {
				gst_buffer_unref(buffer);
			}
		}
	}

	// ===========================================================
	// Релиазация обмена сообщений SDP и ICE
	// ===========================================================

	void UCamera::start_websocket_client(const std::string& ip_adress, const std::string& port, const std::string& url)
	{
		if (!m_websocket_client) {
			m_websocket_client = std::make_shared<UWebSocketClient>(m_io_context, ip_adress, port, url, m_options.name);
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

	void UCamera::on_signaling_message(const std::string& msg)
	{
		try {
			boost::json::value parsed = boost::json::parse(msg);
			boost::json::object& obj = parsed.as_object();

			// Узнаем идентификатор клиента
			std::string client_id;
			if (auto* v = obj.if_contains("client_id"); v && v->is_string()) {
				client_id = v->as_string().c_str();
			}
			else {
				std::cout << color::red << "[UCamera " << m_options.name
					      << "] Error with recieving message: missing client id!\n" << color::reset;
				return;
			}

			// Проверяем тип сообщения
			std::string type;
			if (auto* v = obj.if_contains("type"); v && v->is_string()) {
				type = v->as_string().c_str();
			}
			else {
				std::cout << color::red << "[UCamera " << m_options.name
						  << "] Error with recieving message: missing type!\n" << color::reset; 
				return;
			}

			// Создаем новую сессию, если запрос на подключение
			if (type == "connection") {
				if (auto* v = obj.if_contains("client_id"); v && v->is_string()) {
					client_id = v->as_string().c_str();
					open_new_session(client_id);
					return;
				}
				else {
					std::cout << color::red << "[UCamera " << m_options.name
						<< "] Error at establishing connection: no client_id in json!\n" << color::reset << std::endl;
					return;
				}
			}

			// Ищем открытую сессию по клиенту
			auto it = m_opened_sessions.find(client_id);
			if (it == m_opened_sessions.end()) {
				std::cout << color::red << "[UCamera " << m_options.name 
					      << "] Cannot to find open session to compute the message!\n" << color::reset;
				return;
			}
			auto cur_webrtc = it->second.get()->webrtcbin.get();

			if (type == "offer") {
				auto* sdp_v = obj.if_contains("sdp");
				if (!sdp_v || !sdp_v->is_string()) {
					std::cout << color::red << "[UCamera " << m_options.name 
						      << "] Invalid SDP in offer" << color::reset << std::endl;
					return;
				}
				else {
					std::cout << color::green << "[UCamera" << m_options.name << "] Received SDP offer\n" << color::reset;
				}

				std::string sdp_str = sdp_v->as_string().c_str();

				GstSDPMessage* sdp = nullptr;
				gst_sdp_message_new(&sdp);
				gst_sdp_message_parse_buffer(reinterpret_cast<const guint8*>(sdp_str.c_str()), sdp_str.size(), sdp);

				GstWebRTCSessionDescription* offer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_OFFER, sdp);

				g_signal_emit_by_name(cur_webrtc, "set-remote-description", offer, nullptr);
				gst_webrtc_session_description_free(offer);

				g_signal_emit_by_name(cur_webrtc, "create-answer", nullptr);
			}
			else if (type == "answer") {
				auto* sdp_v = obj.if_contains("sdp");
				if (!sdp_v || !sdp_v->is_string()) {
					std::cout << color::red << "[Camera " << m_options.name
						<< "] Invalid SDP in answer" << color::reset << std::endl;
					return;
				}
				else {
					std::cout << color::green << "[Camera " << m_options.name << "] Recieved SDP answer\n" << color::reset;
				}

				std::string sdp_str = sdp_v->as_string().c_str();

				GstSDPMessage* sdp = nullptr;
				gst_sdp_message_new(&sdp);
				gst_sdp_message_parse_buffer(reinterpret_cast<const guint8*>(sdp_str.c_str()), sdp_str.size(), sdp);

				GstWebRTCSessionDescription* answer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_ANSWER, sdp);

				g_signal_emit_by_name(cur_webrtc, "set-remote-description", answer, nullptr);
				gst_webrtc_session_description_free(answer);
			}
			else if (type == "ice") {
				auto* cand_v = obj.if_contains("candidate");
				auto* line_v = obj.if_contains("sdpMLineIndex");
				auto* mid_v = obj.if_contains("sdpMid");

				std::string candidate;
				std::string sdpMid;
				int mline_index = 0;

				bool fail = false;

				if (cand_v && cand_v->is_string()) {
					candidate = cand_v->as_string();
				}
				else {
					fail = false;
				}

				if (line_v && line_v->is_int64()) {
					mline_index = static_cast<int>(line_v->as_int64());
				}
				else {
					fail = false;
				}

				if (mid_v && mid_v->is_string()) {
					sdpMid = mid_v->as_string();
				}

				if (fail) {
					std::cout << color::red << "[UCamera " << m_options.name << "] Cannot add candidate!\n" << color::reset;
					return;
				}

				if (candidate.find(".local") != std::string::npos) {
					std::cout << color::yellow << "[UCamera " << m_options.name << "] Ignoring mDNS candidate: " 
						      << candidate << color::reset << std::endl;
				}
				else {
					g_signal_emit_by_name(cur_webrtc, "add-ice-candidate", mline_index, candidate.c_str());
					std::cout << color::green << "[UCamera " << m_options.name << "] Added ICE candidate!\n" << color::reset;
				}
			}
			else {
				std::string description;
				if (auto* v = obj.if_contains("description"); v && v->is_string()) {
					description = v->as_string().c_str();
				}
				else {
					std::cout << color::red << "[UCamera " << m_options.name
						      << "] Failed to parse message: " << msg << color::reset << std::endl;
				}

				std::cout << color::yellow << "[UCamera " << m_options.name << "] Info of recieved message: " 
					      << description << color::reset << std::endl;
			}
		}
		catch (const std::exception& e) {
			std::cout << color::red << "[Camera " << m_options.name << "] Unresolved failure: "
				      << e.what() << color::reset << std::endl;
		}
	}

	bool UCamera::set_streaming_pipeline_state(GstState state) {
		gst_element_set_state(m_webrtcbin_pipeline.get(), state);

		GstStateChangeReturn ret = gst_element_get_state(
			m_webrtcbin_pipeline.get(), NULL, NULL,
			GST_SECOND // ждем 1 сек
		);

		if (ret != GST_STATE_CHANGE_SUCCESS) {
			std::cout << "Pipeline FAILED to reach PLAYING!" << std::endl;
			return false;
		}
		else {
			std::cout << "Pipeline is PLAYING!" << std::endl;
			return true;
		}
	}

	void UCamera::open_new_session(const std::string& client_id) {
		if (m_opened_sessions.find(client_id) != m_opened_sessions.end()) {
			std::cout << color::yellow << "[UCamera " << m_options.name << "] Session with client " 
				      << client_id << " has already created!\n" << color::reset;
			send_message(boost::json::serialize(
				json(m_options.name, client_id, false, SIG_TYPE_CONNECT, "Session with this client has already started!"))
			);
			return;
		}

		if (!m_webrtcbin_tee) {
			std::cout << color::red << "[UCamera " << m_options.name
				<< "] Gst tee is nullptr when establish connection with " << client_id << color::reset << std::endl;
			send_message(boost::json::serialize(
				json(m_options.name, client_id, false, SIG_TYPE_CONNECT, "Internal error with tee!"))
			);
			return;
		}

		auto session = std::make_unique<FWebRtcSession>(client_id, m_options.name, [this](const std::string& message) {this->send_message(message);} );

		session->queue = TUniqueGst(gst_element_factory_make("queue", nullptr), gst_object_unref);
		session->webrtcbin = TUniqueGst(gst_element_factory_make("webrtcbin", nullptr), gst_object_unref);

		if (!session->queue || !session->webrtcbin) {
			std::cout << color::red << "[UCamera " << m_options.name 
				      << "] Error with creation gst object when establish connection with " << client_id << color::reset << std::endl;
			send_message(boost::json::serialize(
				json(session.get(), false, SIG_TYPE_CONNECT, "Internal error!"))
			);
			return;
		}

		gst_bin_add_many(GST_BIN(m_webrtcbin_pipeline.get()), session->queue.get(), session->webrtcbin.get(), nullptr);

		using TGstUniqePad = std::unique_ptr<GstPad, decltype(&gst_object_unref)>;

		// Получаем src пад (выходы) от tee для дальнейшего связывания по цепочке
		auto tee_src_pad = TGstUniqePad(gst_element_request_pad_simple(m_webrtcbin_tee.get(), "src_%u"), gst_object_unref);
		if (!tee_src_pad) {
			std::cout << color::red << "[UCamera " << m_options.name
				<< "] Error: tee has not any src pads!\n" << color::reset;
			send_message(boost::json::serialize(
				json(session.get(), false, SIG_TYPE_CONNECT, "Internal error!"))
			);
			return;
		}

		// Получаем входы от очереди
		auto queue_sink_pad = TGstUniqePad(gst_element_get_static_pad(session->queue.get(), "sink"), gst_object_unref);
		if (!queue_sink_pad) {
			std::cout << color::red << "[UCamera " << m_options.name
				<< "] Error: tee has not sink pad!\n" << color::reset;
			send_message(boost::json::serialize(
				json(session.get(), false, SIG_TYPE_CONNECT, "Internal error!"))
			);
			return;
		}

		// Связываем tee с queue
		auto tee_queue_link = gst_pad_link(tee_src_pad.get(), queue_sink_pad.get());
		if (tee_queue_link != GST_PAD_LINK_OK) {
			std::cout << color::red << "[UCamera " << m_options.name
				<< "] Error: tee cannot link with queue!\n" << color::reset;
			send_message(boost::json::serialize(
				json(session.get(), false, SIG_TYPE_CONNECT, "Internal error!"))
			);
			return;
		}

		// Линк созданных объектов друг с другом
		if (!gst_element_link(session->queue.get(), session->webrtcbin.get())) {
			std::cout << color::red << "[UCamera " << m_options.name
				<< "] Error: there is no link with queue and webrtcbin!\n" << color::reset;
			send_message(boost::json::serialize(
				json(session.get(), false, SIG_TYPE_CONNECT, "Internal error!"))
			);
			return;
		}

		GstElement* element = session->queue.get();  // или m_webrtcbin.get()

		// Синхронихируем состояние с основным пайплайном
		gst_element_sync_state_with_parent(session->queue.get());
		gst_element_sync_state_with_parent(session->webrtcbin.get());

		// Привязываем сигналы протокола к только что созданной сессии
		g_signal_connect(session->webrtcbin.get(), "on-negotiation-needed", G_CALLBACK(&UCamera::on_negotiation_needed), session.get());
		g_signal_connect(session->webrtcbin.get(), "on-ice-candidate", G_CALLBACK(&UCamera::on_ice_candidate), session.get());

		boost::json::object opened_msg = json(session.get(), true, SIG_TYPE_CONNECT,
			"Connection with " + session->client_id + " and " + session->camera_name + " established!"
		);

		// Оповещаем, что сессия была добавлена
		{
			std::lock_guard<std::mutex> lock(m_session_mutex);
			m_opened_sessions[client_id] = std::move(session);
			if (!m_has_sessions) {
				set_streaming_pipeline_state(GST_STATE_PLAYING);
				//m_frames_buffer.clear();
			}
			m_has_sessions = true;
		}
		send_message(boost::json::serialize(opened_msg));
		m_session_cv.notify_all();
	}

	void UCamera::close_session(const std::string& client_id) {
		auto it = m_opened_sessions.find(client_id);
		if (it == m_opened_sessions.end()) {
			boost::json::object closed_msg = json(m_options.name, "unknown", false, SIG_TYPE_CONNECT, "There are no one opened sessions!");
			send_message(boost::json::serialize(closed_msg));
			std::cout << color::red << "[UCamera " << m_options.name << "] Error with closing " 
				      << client_id << " session: session doesnt exist!\n" << color::reset;
			return;
		}
		auto& session = it->second;

		gst_element_set_state(session.get()->webrtcbin.get(), GST_STATE_NULL);
		gst_element_set_state(session.get()->queue.get(), GST_STATE_NULL);

		// Убираем элементы из основного pipeline:
		gst_bin_remove(GST_BIN(m_webrtcbin_pipeline.get()), session.get()->webrtcbin.get());
		gst_bin_remove(GST_BIN(m_webrtcbin_pipeline.get()), session.get()->queue.get());

		{
			std::lock_guard<std::mutex> lock(m_session_mutex);
			m_opened_sessions.erase(client_id);
			if (m_opened_sessions.size() == 0) {
				m_has_sessions = false;
				set_streaming_pipeline_state(GST_STATE_NULL);
			}
		}

		boost::json::object closed_msg = json(session.get(), false, SIG_TYPE_CONNECT,
			"Connection with " + session->client_id + " and " + session->camera_name + " closed!"
		);
		send_message(boost::json::serialize(closed_msg));

		std::cout << color::yellow << "[UCamera " << m_options.name << "] Closed session with client " 
			      << client_id << color::reset << std::endl;
	}

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

	void UCamera::on_negotiation_needed(GstElement* webrtcbin, gpointer data) {
		auto session = static_cast<FWebRtcSession*>(data);
		if (!session) {
			std::cout << color::red << "[UCamera] Negotiation needed - nullptr with camera!\n" << color::reset;
			return;
		}
		if (!webrtcbin) {
			std::cout << color::red << "[UCamera " << session->camera_name << "] Negotiation needed - webrtcbin fault!\n" << color::reset;
			return;
		}
		std::cout << color::yellow << "[UCamera " << session->camera_name << "] Negotiation needed - creating offer\n" << color::reset;

		auto promise = gst_promise_new_with_change_func(&UCamera::on_offer_created, session, nullptr);
		if (!promise) {
			std::cout << color::red << "[UCamera " << session->camera_name << "] Negotiation needed - nullptr with promise!\n" << color::reset;
			return;
		}

		g_signal_emit_by_name(webrtcbin, "create-offer", nullptr, promise);
	}

	void UCamera::on_offer_created(GstPromise* promise, gpointer data) {
		auto session = static_cast<FWebRtcSession*>(data);
		if (!session) {
			std::cout << color::red << "[UCamera] on_offer_created - nullptr camera\n" << color::reset;
			gst_promise_unref(promise);  // обязательно unref даже при ошибке
			return;
		}

		const GstStructure* reply = gst_promise_get_reply(promise);
		if (!reply) {
			std::cout << color::red << "[UCamera " << session->camera_name << "] on_offer_created - cannot get reply\n" << color::reset;
			gst_promise_unref(promise);
			return;
		}

		GstWebRTCSessionDescription* offer = nullptr;
		if (!gst_structure_get(reply, "offer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &offer, nullptr) || !offer) {
			std::cout << color::red << "[UCamera " << session->camera_name << "] on_offer_created - cannot get offer from reply\n" << color::reset;
			gst_promise_unref(promise);
			return;
		}

		// Устанавливаем локальное описание (offer)
		g_signal_emit_by_name(session->webrtcbin.get(), "set-local-description", offer, nullptr);

		// Теперь можно unref промис, reply уже получен
		gst_promise_unref(promise);

		gchar* sdp_str = gst_sdp_message_as_text(offer->sdp);
		if (!sdp_str) {
			std::cout << color::red << "[UCamera " << session->camera_name << "] on_offer_created - cannot convert SDP to text\n" << color::reset;
			gst_webrtc_session_description_free(offer);
			return;
		}

		boost::json::object offer_msg = json(session, true, "offer", "Created sdp offer!");
		offer_msg[SIG_SDP] = std::string(sdp_str);

		g_free(sdp_str);

		session->send_message(boost::json::serialize(offer_msg));

		std::cout << color::green << "[UCamera " << session->camera_name << "] Created and sent SDP offer\n" << color::reset;

		gst_webrtc_session_description_free(offer);
	}

	void UCamera::on_ice_candidate(GstElement* webrtcbin, guint mlineindex, gchar* candidate, gpointer data) {
		auto session = static_cast<FWebRtcSession*>(data);

		boost::json::object ice_msg = json(session, true, "ice", "Sending Ice candidate");
		ice_msg[SIG_ICE_CANDIDATE] = std::string(candidate);
		ice_msg[SIG_ICE_LINE_INDEX] = static_cast<int>(mlineindex);

		session->send_message(boost::json::serialize(ice_msg));
	}

	void UCamera::on_ice_connection_state(GstElement* session, GstWebRTCICEConnectionState state, gpointer data) {
		
	}

	// Заготовленные json
	boost::json::object UCamera::json(
		const FWebRtcSession* session,
		bool successed, 
		const std::string& type,
		const std::string& description
	)
	{
		boost::json::object message;
		message["type"] = type;
		if (!session) {
			message[SIG_RET] = SIG_RET_FAULT;
			message[SIG_DECRIPTION] = "Attempt to establish with non-existing session!";
		}
		else {
			message[SIG_RET] = successed ? SIG_RET_SUCCESS : SIG_RET_FAULT;
			message[SIG_CLIENT] = session->client_id;
			message[SIG_CAMERA] = session->camera_name;
			message[SIG_DECRIPTION] = description;
		}
		return message;
	}

	boost::json::object UCamera::json(
		const std::string& camera,
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
		message[SIG_CAMERA] = camera;
		message[SIG_DECRIPTION] = description;
		return message;
	}

} // namespace neural
} // namespace varan