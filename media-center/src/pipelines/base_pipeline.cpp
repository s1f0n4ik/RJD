#include "video_pipeline.h"
#include "signaling_definers.h"
#include <thread>

#include <gst/rtsp/gstrtsptransport.h>

UCameraPipeline::UCameraPipeline(
    const FPipelineConfig& parameters,
    std::unique_ptr<ULogger> logger,
    std::function<void(std::string)> send_callback
)
    : m_logger(std::move(logger))
    , m_parameters(std::move(parameters))
    , m_send_callback(std::move(send_callback))
{
    
}

UCameraPipeline::~UCameraPipeline() {
    teardown();
    // Очищаем callback
    m_send_callback = nullptr;
}

EPipelineStatus UCameraPipeline::get_status() {
    return m_status;
}

bool UCameraPipeline::initialize() {
    if (m_has_initialized) {
        if (m_logger) m_logger->info("inititalize(): Pipeline already initialized!");
        return true;
    }
    if (m_logger) m_logger->info("Initializing " + m_parameters.name + " pipeline..");

    const int probe_timeout = 5;   // timeout на каждый probe
    const int max_attempts = 10;   // сколько попыток сделать
    const int reconnect_delay = 2; // задержка между попытками

    for (int attempt = 1; attempt <= max_attempts; ++attempt) {
        if (m_stop_requested.load()) {
            if (m_logger) m_logger->info("initialize(): stop requested, aborting");
            return false;
        }

        if (m_logger) m_logger->info("Probe attempt " + std::to_string(attempt) + "/" + std::to_string(max_attempts));

        if (probe_video_stream(probe_timeout)) {
            m_status.store(EPipelineStatus::INITIALIZED);
            return true;
        }

        if (m_stop_requested.load()) {
            if (m_logger) m_logger->info("initialize(): stop requested after probe, aborting");
            return false;
        }

        if (m_logger) m_logger->warn("Camera stream not found, retrying in " + std::to_string(reconnect_delay) + "s...");
        {
            std::unique_lock<std::mutex> lock(m_restart_cv_mutex);
            m_restart_cv.wait_for(lock, std::chrono::seconds(reconnect_delay),
                [this] { return m_stop_requested.load(); }
            );
        }
    }

    if (m_logger) m_logger->error("Failed to detect camera stream after " + std::to_string(max_attempts) + " attempts!");
    return false;
}

bool UCameraPipeline::start() {
    std::lock_guard<std::mutex> lock(m_pipeline_mutex);

    if (!m_pipeline) {
        m_logger->error("Cannot start pipeline: pipeline is null.");
        return false;
    }

    GstStateChangeReturn ret = gst_element_set_state(m_pipeline, GST_STATE_PLAYING);
    if (ret == GST_STATE_CHANGE_FAILURE) {
        m_logger->error("Failed to set pipeline state to PLAYING.");
        return false;
    }

    m_status.store(EPipelineStatus::PLAYING);
    m_is_playing = true;
    m_logger->info("Pipeline started successfully.");
    return true;
}

void UCameraPipeline::request_stop() {
    m_stop_requested.store(true);
    m_restart_cv.notify_all();
}

bool UCameraPipeline::stop() {
    std::lock_guard<std::mutex> lock(m_pipeline_mutex);

    if (!m_pipeline) {
        m_logger->warn("Pipeline is null, nothing to stop.");
        return true;
    }

    GstStateChangeReturn ret = gst_element_set_state(m_pipeline, GST_STATE_PAUSED);
    if (ret == GST_STATE_CHANGE_FAILURE) {
        m_logger->error("Failed to set pipeline state to PAUSED.");
        return false;
    }

    m_is_playing = false;
    m_logger->info("Pipeline paused successfully.");
    m_status.store(EPipelineStatus::STOPPED);
    return true;
}

bool UCameraPipeline::teardown(bool is_blocking)
{
    // Блокируем мьютексом
    std::unique_lock<std::mutex> lock(m_teardown_mutex);
    if (m_status.load() == EPipelineStatus::NONE) {
        if (m_logger) m_logger->warn("teardown(): pipeline already destroyed!");
        return true;
    }

    // Без вариантов уничтожаем bus, чтобы он не вызвал несуществующие методы
    invalidate_bus_watch();

    // Если уничтожающий - вызываем стоп сигнал
    if (is_blocking) {
        (m_stop_requested.exchange(true));
        m_restart_cv.notify_all();

        if (m_restart_thread.joinable()) {
            m_restart_thread.join();
        }
        m_is_restarting.store(false);
    }

    teardown_prefix();

    if (!m_pipeline) {
        if (m_logger) m_logger->warn("teardown(): pipeline already destroyed or null.");
        return true;
    }

    m_is_playing = false;

    // Удаление всех сессий, отправление клиентам сообщения о закрытии
    for (const auto& [id, session] : m_webrtc_sessions) {
        broadcast_session_closed(session->get_client_id(), varan::signaling::CODE_SESSION_RESTARTED,
            "session closed by stream teardown");
        session->teardown();
    }
    m_webrtc_sessions.clear();
    m_tees.clear();

    // Останавливаем сетевые потоки
    //gst_element_send_event(m_pipeline, gst_event_new_flush_start());
    //gst_element_send_event(m_pipeline, gst_event_new_flush_stop(TRUE));

    // Переводим pipeline в NULL
    if (!m_pipeline || !GST_IS_ELEMENT(m_pipeline)) {
        if (m_logger) m_logger->error("teardown(): m_pipeline is NOT a valid GstElement! ptr="
            + std::to_string(reinterpret_cast<uintptr_t>(m_pipeline)));
        m_pipeline = nullptr;
        //return false;
    }
    else {
        GstStateChangeReturn ret = gst_element_set_state(m_pipeline, GST_STATE_NULL);
        if (ret == GST_STATE_CHANGE_FAILURE) {
            m_logger->error("teardown(): failed to initiate state change to NULL.");
        }
        else {
            m_logger->info("teardown(): pipeline reached NULL state successfully.");
        }
        gst_object_unref(m_pipeline);
        m_pipeline = nullptr;
    }

    // Очистка локальных структур
    m_probe.got_codec = false;
    m_probe.got_video_info = false;
    m_has_initialized = false;
    if (is_blocking) {
        m_stop_requested.store(false);
    }

    if (m_logger) m_logger->info("teardown(): pipeline destroyed successfully");
    m_status.store(EPipelineStatus::NONE);
    return true;
}

bool UCameraPipeline::teardown_prefix() {
    return true;
}

void UCameraPipeline::restart_loop() {
    if (m_logger) m_logger->info("restart_loop(): Started for " + m_parameters.name);

    while (m_is_restarting && !m_stop_requested.load()) {
        if (m_logger) m_logger->info("restart_loop(): Attempt restart #" + std::to_string(m_restart_attempts + 1));

        bool success = true;

        if (!teardown(false) && !m_stop_requested.load()) {
            if (m_logger) m_logger->error("restart_loop(): teardown() pipeline failed");
            success = false;
        }

        if (success && !initialize() && !m_stop_requested.load()) {
            if (m_logger) m_logger->error("restart_loop(): initialize() pipeline failed");
            success = false;
        }

        if (success && !start() && !m_stop_requested.load()) {
            if (m_logger) m_logger->error("restart_loop(): start() pipeline failed");
            success = false;
        }

        if (m_stop_requested.load()) {
            if (m_logger) m_logger->warn("restart_loop(): stop requested at pipeline, restart aborted");
            break;
        }

        if (success)
        {
            if (m_logger) m_logger->info("restart_loop(): Pipeline restarted successfully");

            // сброс backoff
            m_restart_attempts = 0;
            m_backoff_ms = 1000;
            m_is_restarting = false;

            return;
        }

        m_restart_attempts++;
        if (m_logger) m_logger->warn("restart_loop(): Retry in " + std::to_string(m_backoff_ms) + " ms");

        {
            std::unique_lock<std::mutex> lock(m_restart_cv_mutex);
            m_restart_cv.wait_for(lock, 
                std::chrono::milliseconds(m_backoff_ms),
                [this] {
                    if (m_logger) m_logger->warn("restart_loop(): exit from loop, stop requested!");
                    return m_stop_requested.load(); 
                }
            );
        }

        m_backoff_ms = std::min(m_backoff_ms * 2, m_max_backoff_ms);
    }

    m_logger->info("restart_loop(): Restart loop stopped");
    m_is_restarting = false;
}

void UCameraPipeline::shedule_restart() {
    if (m_stop_requested.load()) {
        m_logger->warn("shedule_restart(): skip, pipeline is destroying");
        return;
    }

    if (m_is_restarting.exchange(true)) {
        m_logger->warn("shedule_restart(): Restart already in progress");
        return;
    }

    if (m_restart_thread.joinable()) {
        m_restart_thread.join();
    }

    m_restart_thread = std::thread([this] {
        this->restart_loop();
    });
}

void UCameraPipeline::stop_restart_thread() {
    m_is_restarting = false;
}

bool UCameraPipeline::probe_video_stream(int timeout_sec) {
    if (m_stop_requested.load()) return false;

    if (m_logger) m_logger->debug("Initializing probe pipeline...");
    if (m_logger) m_logger->debug("Trying to connect to camera with rtsp: " + m_parameters.rtsp_url);
    m_status.store(EPipelineStatus::PROBING);

    auto pipeline = gst_pipeline_new("probe-pipeline");
    auto src = gst_element_factory_make("rtspsrc", nullptr);
    auto decoder = gst_element_factory_make("mppvideodec", nullptr);
    auto sink = gst_element_factory_make("fakesink", nullptr);

    if (!pipeline || !src || !decoder || !sink) {
        if (m_logger) {
            // Без имени фабрики причина неотличима: нет плагина, ABI, чёрный список реестра
            std::string missing;
            if (!pipeline) missing += " probe-pipeline";
            if (!src)      missing += " rtspsrc";
            if (!decoder)  missing += " mppvideodec";
            if (!sink)     missing += " fakesink";
            m_logger->error("Failed to create probe pipeline elements, missing:" + missing);
        }
        // Созданные элементы в bin не попали — владение осталось здесь
        if (sink)     gst_object_unref(sink);
        if (decoder)  gst_object_unref(decoder);
        if (src)      gst_object_unref(src);
        if (pipeline) gst_object_unref(pipeline);
        return false;
    }

    g_object_set(src,
        "location", m_parameters.rtsp_url.c_str(),
        "protocols", GST_RTSP_LOWER_TRANS_TCP,
        "latency", 0,
        nullptr);

    gst_bin_add_many(GST_BIN(pipeline), src, decoder, sink, nullptr);

    FProbeContext ctx{
        pipeline,
        decoder,
        sink,
        &m_probe,
        m_logger.get()
    };

    g_signal_connect(src, "pad-added", G_CALLBACK(on_rtsp_pad_added), &ctx);

    GstPad* dec_src = gst_element_get_static_pad(decoder, "src");

    gst_pad_add_probe(dec_src, GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM, on_decoder_caps, &ctx, nullptr);
    gst_object_unref(dec_src);

    // Запуск пайплайна
    m_logger->debug("Setting probe pipeline to PLAYING state...");
    gst_element_set_state(pipeline, GST_STATE_PLAYING);

    // Локальный: в поле объекта лежит наблюдатель основного конвейера
    auto probe_watch = setup_bus_watch(pipeline, true);

    // Шину читает только наблюдатель, здесь ждём готовности по таймеру
    gint64 deadline = g_get_monotonic_time() + timeout_sec * G_TIME_SPAN_SECOND;
    while (!m_probe.ready() && !m_stop_requested.load() && g_get_monotonic_time() < deadline) {
        std::unique_lock<std::mutex> lock(m_restart_cv_mutex);
        m_restart_cv.wait_for(lock, std::chrono::milliseconds(200),
            [this] { return m_stop_requested.load(); }
        );
    }

    // Снимаем до разбора трубы, чтобы наблюдатель не пережил свою шину
    probe_watch.reset();

    gst_element_set_state(pipeline, GST_STATE_NULL);
    gst_element_get_state(pipeline, nullptr, nullptr, 3 * GST_SECOND);
    gst_object_unref(pipeline);

    if (m_stop_requested.load()) {
        if (m_logger) m_logger->info("probe_video_stream(): interrupted by stop request");
        return false;
    }

    if (!m_probe.ready()) {
        if (m_logger) m_logger->warn("Probe failed: stream not ready.");
        return false;
    }

    std::ostringstream oss;
    oss << "Probe succeeded:\n\tcodec=" << m_probe.codec_name << "\n\twidth=" << m_probe.width << "\n\theight=" << m_probe.height;
    if (m_logger) m_logger->info(oss.str());
    return true;
}

UCameraPipeline::FBusWatch UCameraPipeline::setup_bus_watch(GstElement* pipeline, bool use_probe_handler) {
    if (!pipeline) return {};

    auto ctx = std::make_shared<FBusWatchContext>();
    ctx->pipeline = this;
    ctx->use_probe_handler = use_probe_handler;

    // Делаем копию и передаем ее в шину. Пока жив хотя бы один источник - оно работает
    auto* ctx_holder = new std::shared_ptr<FBusWatchContext>(ctx);

    GstBus* bus = gst_element_get_bus(pipeline);
    const guint watch_id = gst_bus_add_watch_full(
        bus,
        G_PRIORITY_DEFAULT,
        +[](GstBus*, GstMessage* msg, gpointer data) -> gboolean {
            auto ctx = *static_cast<std::shared_ptr<FBusWatchContext>*>(data);
            if (!ctx) return TRUE;

            std::lock_guard<std::mutex> lock(ctx->mutex);
            auto self = ctx->pipeline;
            if (!self) return TRUE;

            auto probe_handler = ctx->use_probe_handler;

            switch (GST_MESSAGE_TYPE(msg)) {
            case GST_MESSAGE_ERROR: {
                GError* err = nullptr;
                gchar* debug = nullptr;
                gst_message_parse_error(msg, &err, &debug);

                std::string err_msg = err ? err->message : "unknown";
                std::string dbg_msg = debug ? debug : "none";
                self->m_logger->error("GST ERROR: " + err_msg + " | debug: " + dbg_msg);

                // Определяем код ошибки
                int code = varan::signaling::CODE_GST_ERROR;
                if (err) {
                    std::string msg_lower = err_msg;
                    std::transform(msg_lower.begin(), msg_lower.end(),
                        msg_lower.begin(), ::tolower);

                    if (msg_lower.find("unauthorized") != std::string::npos ||
                        msg_lower.find("401") != std::string::npos) {
                        code = varan::signaling::CODE_RTSP_UNAUTHORIZED;
                    }
                    else if (msg_lower.find("not found") != std::string::npos ||
                        msg_lower.find("404") != std::string::npos ||
                        msg_lower.find("no route") != std::string::npos) {
                        code = varan::signaling::CODE_RTSP_NOT_FOUND;
                    }
                    else if (msg_lower.find("timeout") != std::string::npos ||
                        msg_lower.find("timed out") != std::string::npos) {
                        code = varan::signaling::CODE_RTSP_TIMEOUT;
                    }
                    else if (msg_lower.find("end-of-file") != std::string::npos ||
                        msg_lower.find("received end") != std::string::npos ||
                        msg_lower.find("could not receive message") != std::string::npos) {
                        code = varan::signaling::CODE_RTSP_DISCONNECTED;
                    }
                }

                if (err) g_error_free(err);
                if (debug) g_free(debug);

                self->on_bus_error(code, err_msg, probe_handler);
                break;
            }
            case GST_MESSAGE_EOS: {
                self->m_logger->warn("GST EOS received");
                self->on_bus_error(varan::signaling::CODE_EOS, "End of stream", probe_handler);
                break;
            }
            case GST_MESSAGE_ELEMENT: {
                const GstStructure* s = gst_message_get_structure(msg);
                if (s && gst_structure_has_name(s, "GstRTSPSrcTimeout")) {
                    self->m_logger->warn("RTSP timeout detected");
                    self->on_bus_error(varan::signaling::CODE_RTSP_TIMEOUT, "RTSP connection timed out", probe_handler);
                }
                break;
            }
            default:
                break;
            }

            // Вызываем виртуальный хук для специфики подкласса
            self->on_bus_message(msg);

            return TRUE;
        },
        ctx_holder,
        [](gpointer data) {
            delete static_cast<std::shared_ptr<FBusWatchContext>*>(data);
        }
    );
    gst_object_unref(bus);

    return FBusWatch(watch_id, std::move(ctx));
}

void UCameraPipeline::invalidate_bus_watch() {
    m_bus_watch.reset();
}

void UCameraPipeline::on_bus_error(int code, const std::string& description, bool is_probe) {
    broadcast_error(code, description);
    // Не рестартим
    //shedule_restart();
}

void UCameraPipeline::broadcast_session_closed(const std::string& client_id, int code,
                                              const std::string& description) {
    if (!m_send_callback) return;

    boost::json::object msg;
    msg[SIG_TYPE] = SIG_TYPE_CLOSE;
    msg[SIG_SENDER] = SIG_SENDER_CAMERA;
    msg[SIG_CAMERA] = m_parameters.camera_name;
    msg[SIG_STREAM] = m_parameters.name;
    msg[SIG_CLIENT] = client_id;
    msg[SIG_RET] = SIG_RET_FAULT;
    msg[SIG_CODE] = code;
    msg[SIG_DECRIPTION] = description;

    m_send_callback(boost::json::serialize(msg));
}

void UCameraPipeline::broadcast_error(int code, const std::string& description) {
    if (!m_send_callback) return;

    boost::json::object msg;
    msg[SIG_TYPE] = SIG_TYPE_STREAM_ERROR;
    msg[SIG_SENDER] = SIG_SENDER_CAMERA;
    msg[SIG_CAMERA] = m_parameters.camera_name;
    msg[SIG_STREAM] = m_parameters.name;
    msg[SIG_CODE] = code;
    // Строковый код для сборок интерфейса, которые ещё не знают числовых
    msg[SIG_ERROR_CODE] = varan::signaling::legacy_stream_code(code);
    msg[SIG_DECRIPTION] = description;
    msg[SIG_RET] = SIG_RET_FAULT;

    m_send_callback(boost::json::serialize(msg));
}

const GstStructure* UCameraPipeline::extract_caps_structure(GstPadProbeInfo* info, ULogger* logger)
{
    // Проверяем тип probe
    if (!(info->type & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM)) {
        return nullptr;
    }

    GstEvent* event = gst_pad_probe_info_get_event(info);
    if (!event || GST_EVENT_TYPE(event) != GST_EVENT_CAPS) {
        return nullptr;
    }

    GstCaps* caps = nullptr;
    gst_event_parse_caps(event, &caps);

    if (!caps || gst_caps_is_empty(caps)) {
        logger->debug("CAPS is empty.");
        return nullptr;
    }

    gchar* caps_str = gst_caps_to_string(caps);
    logger->info(std::string("Extracted caps: ") + caps_str);
    g_free(caps_str);

    return gst_caps_get_structure(caps, 0);
}

GstPadProbeReturn UCameraPipeline::on_decoder_caps(GstPad*, GstPadProbeInfo* info, gpointer user_data)
{
    auto* ctx = static_cast<FProbeContext*>(user_data);
    auto* result = ctx->result;
    auto* logger = ctx->logger;

    if (result->got_video_info) {
        return GST_PAD_PROBE_REMOVE;
    }

    const GstStructure* s = extract_caps_structure(info, logger);
    if (!s) {
        logger->debug("Decoder pad probe: no structure yet.");
        return GST_PAD_PROBE_OK;
    }

    int width = 0, height = 0;
    if (gst_structure_get_int(s, "width", &width) &&
        gst_structure_get_int(s, "height", &height))
    {
        result->width = width;
        result->height = height;
        result->got_video_info = true;
        logger->debug("Decoder pad probe: width=" + std::to_string(width) +
            " height=" + std::to_string(height));
        return GST_PAD_PROBE_REMOVE;
    }

    return GST_PAD_PROBE_OK;
}

void UCameraPipeline::on_rtsp_pad_added(GstElement*, GstPad* pad, gpointer user_data)
{
    auto* ctx = static_cast<FProbeContext*>(user_data);
    auto* result = ctx->result;
    auto* logger = ctx->logger;

    logger->debug("RTSP pad added, probing CAPS...");

    GstCaps* caps = gst_pad_get_current_caps(pad);
    if (!caps) {
        caps = gst_pad_query_caps(pad, nullptr);
    }

    if (!caps || gst_caps_is_empty(caps)) {
        logger->debug("No caps available on pad yet.");
        return;
    }

    const GstStructure* s = gst_caps_get_structure(caps, 0);

    const gchar* encoding = gst_structure_get_string(s, "encoding-name");

    if (!encoding) {
        logger->warn("Caps found but encoding-name missing.");
        gst_caps_unref(caps);
        return;
    }

    logger->debug(std::string("Detected encoding: ") + encoding);

    bool is_h264 = g_strcmp0(encoding, "H264") == 0;
    bool is_h265 = g_strcmp0(encoding, "H265") == 0;

    if (!is_h264 && !is_h265) {
        logger->warn(std::string("Unsupported codec: ") + encoding);
        gst_caps_unref(caps);
        return;
    }

    result->codec_name = encoding;
    result->got_codec = true;

    const char* depay_name = is_h264 ? "rtph264depay" : "rtph265depay";
    const char* parse_name = is_h264 ? "h264parse" : "h265parse";

    GstElement* depay = gst_element_factory_make(depay_name, nullptr);
    GstElement* parse = gst_element_factory_make(parse_name, nullptr);

    if (!depay || !parse) {
        logger->error("Failed to create depay/parse elements.");
        gst_caps_unref(caps);
        return;
    }

    logger->debug(std::string("Adding depay: ") + depay_name + ", parse: " + parse_name);
    gst_bin_add_many(GST_BIN(ctx->pipeline), depay, parse, nullptr);

    gst_element_sync_state_with_parent(depay);
    gst_element_sync_state_with_parent(parse);

    if (!gst_element_link_many(depay, parse, ctx->decoder, ctx->sink, nullptr)) {
        logger->error("Failed to link depay -> parse -> decoder -> sink");
        gst_caps_unref(caps);
        return;
    }

    GstPad* sink_pad = gst_element_get_static_pad(depay, "sink");
    if (!sink_pad) {
        logger->error("Failed to get depay sink pad.");
        gst_caps_unref(caps);
        return;
    }

    if (gst_pad_link(pad, sink_pad) != GST_PAD_LINK_OK) {
        logger->error("Failed to link RTSP pad to depay.");
    }
    else {
        logger->debug("Successfully linked RTSP pad to depay.");
    }

    gst_object_unref(sink_pad);
    gst_caps_unref(caps);
}

bool UCameraPipeline::create_webrtc_session(
    const std::string& client_id,
    const std::string& session_id,
    std::string& description,
    int& code
) {
    std::ostringstream oss_error;

    if (!m_probe.ready()) {
        oss_error << "Session cannot be created: no probing " << m_parameters.name << " pipeline!";
        description = oss_error.str();
        code = varan::signaling::CODE_SESSION_CREATE_FAILED;
        return false;
    }

    if (m_pending_teardown_clients.count(client_id)) {
        description = "Previous session of " + client_id + " is still tearing down, try again later.";
        code = varan::signaling::CODE_SESSION_CREATE_FAILED;
        return false;
    }

    auto ses_it = m_webrtc_sessions.find(session_id);
    if (ses_it != m_webrtc_sessions.end()) {
        oss_error << "Session " << session_id << " in " << m_parameters.name << " pipeline already exists!";
        description = oss_error.str();
        code = varan::signaling::CODE_SESSION_EXISTS;
        return false;
    }

    return true;
}

bool UCameraPipeline::close_webrtc_session(const std::string& session_id, std::string& description, int& code) {
    auto it = m_webrtc_sessions.find(session_id);
    if (it == m_webrtc_sessions.end()) {
        description = "Cannot close session " + session_id + ": session doesn't exist!";
        code = varan::signaling::CODE_SESSION_NOT_FOUND;
        return false;
    }

    std::unique_ptr<UWebRTCSession> session = std::move(it->second);
    m_webrtc_sessions.erase(it);

    // Пока сессия рвётся, новую этому клиенту не создаём: разбор и создание
    // сходятся на одном tee и мешают друг другу
    const std::string client_id = session->get_client_id();
    m_pending_teardown_clients.insert(client_id);

    bool needs_restart = session->is_timeout_triggered();

    struct TeardownCtx {
        UCameraPipeline* pipeline;
        std::unique_ptr<UWebRTCSession> session;
        std::string client_id;
    };

    auto* ctx = new TeardownCtx{
        this,
        std::move(session),
        client_id
    };

    g_main_context_invoke(nullptr,
        [](gpointer data) -> gboolean {
            auto* ctx = static_cast<TeardownCtx*>(data);
            ctx->session->teardown();
            ctx->pipeline->m_pending_teardown_clients.erase(ctx->client_id);
            delete ctx;
            return G_SOURCE_REMOVE;
        },
        ctx
    );

    if (needs_restart) {
        description = "Session " + session_id + " closed by timeout, scheduling pipeline restart.";
        shedule_restart();
    }
    else {
        description = "Session " + session_id + " closed successfully.";
    }

    return true;
}

bool UCameraPipeline::process_webrtc_session(
    const std::string& session_id, 
    const boost::json::object& message,
    const std::string& type,
    std::string& description,
    int& code
) {
    // Проверяем есть ли сессия
    auto it_client = m_webrtc_sessions.find(session_id);
    if (it_client == m_webrtc_sessions.end()) {
        description = "Cannot process message: session " + session_id + " doesn't exist!";
        code = varan::signaling::CODE_SESSION_NOT_FOUND;
        return false;
    }
    // Сессия существует
    auto session = it_client->second.get();

    if (type == "offer" || type == "answer" || type == "ice") {
        const bool ret = type == "offer" ? session->make_offer(message, description)
            : type == "answer" ? session->create_answer(message, description)
            : session->add_ice_candidate(message, description);

        if (!ret) {
            code = varan::signaling::CODE_SESSION_NEGOTIATION;
        }
        return ret;
    }

    description = "No supported type of recieved message!";
    code = varan::signaling::CODE_UNKNOWN_MESSAGE;
    return false;
}
