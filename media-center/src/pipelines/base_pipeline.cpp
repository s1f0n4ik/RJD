#include "video_pipeline.h"
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
    GstState state = GST_STATE_NULL;
    GstState pending = GST_STATE_NULL;

    if (!m_has_initialized) {
        return EPipelineStatus::NONE;
    }
    gst_element_get_state(m_pipeline, &state, &pending, 0);

    switch (state) {
    case GST_STATE_NULL:
        if (m_has_initialized) return EPipelineStatus::INITIALIZED;
        if (m_is_restarting) return EPipelineStatus::RESTARTING;
        return EPipelineStatus::NONE;
    case GST_STATE_READY:
        return EPipelineStatus::READY;
    case GST_STATE_PAUSED:
        return EPipelineStatus::STOPPED;
    case GST_STATE_PLAYING:
        return EPipelineStatus::PLAYING;
    default:
        return EPipelineStatus::NONE;
    }
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
    return true;
}

bool UCameraPipeline::teardown(bool is_blocking)
{
    // Если уничтожающий - вызываем стоп сигнал
    if (is_blocking) {
        (m_stop_requested.exchange(true));
        m_restart_cv.notify_all();

        if (m_restart_thread.joinable()) {
            m_restart_thread.join();
        }
        m_is_restarting.store(false);
    }

    // Теперь переходим к самому пайплайну
    std::lock_guard<std::mutex> lock(m_pipeline_mutex);

    teardown_prefix();

    if (!m_pipeline) {
        m_logger->warn("teardown(): pipeline already destroyed or null.");
        return true;
    }

    m_is_playing = false;

    // Удаляем все сессии
    for (const auto& [name, session] : m_webrtc_sessions) {
        session->teardown();
    }
    m_webrtc_sessions.clear();
    m_tees.clear();

    // Останавливаем сетевые потоки
    //gst_element_send_event(m_pipeline, gst_event_new_flush_start());
    //gst_element_send_event(m_pipeline, gst_event_new_flush_stop(TRUE));

    // Отвязывает pipeline
    if (m_bus_watch_id != 0) {
        g_source_remove(m_bus_watch_id);
        m_bus_watch_id = 0;
    }

    // Переводим pipeline в NULL
    if (!m_pipeline || !GST_IS_ELEMENT(m_pipeline)) {
        m_logger->error("teardown(): m_pipeline is NOT a valid GstElement! ptr="
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

    m_logger->info("teardown(): pipeline destroyed successfully");
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

    auto pipeline = gst_pipeline_new("probe-pipeline");
    auto src = gst_element_factory_make("rtspsrc", nullptr);
    auto decoder = gst_element_factory_make("mppvideodec", nullptr);
    auto sink = gst_element_factory_make("fakesink", nullptr);

    if (!pipeline || !src || !decoder || !sink) {
        if (m_logger) m_logger->error("Failed to create probe pipeline elements.");
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

    GstBus* bus = gst_element_get_bus(pipeline);
    gint64 deadline = g_get_monotonic_time() + timeout_sec * G_TIME_SPAN_SECOND;
    while (!m_probe.ready() && !m_stop_requested.load() && g_get_monotonic_time() < deadline) {
        GstMessage* msg = gst_bus_timed_pop(bus, 200 * GST_MSECOND);

        if (!msg) {
            continue;
        }

        if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
            GError* err = nullptr;
            gchar* debug_info = nullptr;
            gst_message_parse_error(msg, &err, &debug_info);

            std::ostringstream oss;
            oss << "GST_MESSAGE_ERROR received from element: "
                << GST_OBJECT_NAME(msg->src) << "\n"
                << "Error message: " << (err ? err->message : "unknown") << "\n"
                << "Debug info: " << (debug_info ? debug_info : "none");

            if (m_logger) m_logger->error(oss.str());

            if (err) g_error_free(err);
            if (debug_info) g_free(debug_info);

            gst_message_unref(msg);
            break;
        }

        gst_message_unref(msg);
    }

    gst_object_unref(bus);

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

bool UCameraPipeline::create_webrtc_session(const std::string& client_id, std::string& description) {
    std::ostringstream oss_error;

    if (!m_probe.ready()) {
        oss_error << "Session cannot be created: no probing " << m_parameters.name << " pipeline!";
        description = oss_error.str();
        return false;
    }

    auto ses_it = m_webrtc_sessions.find(client_id);
    if (ses_it != m_webrtc_sessions.end()) {
        oss_error << "Session with " << client_id << " in " << m_parameters.name << " pipeline already exists!";
        description = oss_error.str();
        return false;
    }

    return true;
}

bool UCameraPipeline::close_webrtc_session(const std::string& client_id, std::string& description) {
    auto it = m_webrtc_sessions.find(client_id);
    if (it == m_webrtc_sessions.end()) {
        description = "Cannot close session with " + client_id + ": session doesn't exist!";
        return false;
    }

    // Забираем владение
    std::unique_ptr<UWebRTCSession> session = std::move(it->second);
    m_webrtc_sessions.erase(it);

    // Передаём владение в GLib main loop
    g_main_context_invoke(nullptr,
        [](gpointer data) -> gboolean {
            // В data лежит уникальный указатель
            std::unique_ptr<UWebRTCSession> session_ptr(
                static_cast<UWebRTCSession*>(data)
            );

            // teardown будет вызван внутри main thread
            session_ptr->teardown();

            // session_ptr уничтожится после выхода из лямбды
            return G_SOURCE_REMOVE;
        },
        session.release() // release передаёт владение
    );

    description = "Session with " + client_id + " successfully closed!";
    return true;
}

bool UCameraPipeline::process_webrtc_session(
    const std::string& client_id, 
    const boost::json::object& message,
    const std::string& type,
    std::string& description
) {
    // Проверяем есть ли сессия
    auto it_client = m_webrtc_sessions.find(client_id);
    if (it_client == m_webrtc_sessions.end()) {
        description = "Cannot process message: session with client " + client_id + " doesn't exist!";
        return false;
    }
    // Сессия существует
    auto session = it_client->second.get();

    if (type == "offer") {
        return session->make_offer(message, description);
    }
    else if (type == "answer") {
        return session->create_answer(message, description);
    }
    else if (type == "ice") {
        return session->add_ice_candidate(message, description);
    }
    else {
        description = "No supported type of recieved message!";
        return false;
    }

    return true;
}
