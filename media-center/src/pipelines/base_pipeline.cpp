#include "video_pipeline.h"
#include <thread>

#include <gst/rtsp/gstrtsptransport.h>

UCameraPipeline::UCameraPipeline(const FPipelineParameters& parameters)
	: m_logger(parameters.camera_name + ": " + parameters.name, parameters.debug_level)
	, m_parameters(std::move(parameters))
{
	
}

UCameraPipeline::~UCameraPipeline() {
    // Если запущен поток - завершаем
    if (m_restart_thread.joinable()) {
        m_restart_thread.join();
    }

    destroy();
}

EPipelineStatus UCameraPipeline::get_status() {
    GstState state = GST_STATE_NULL;
    GstState pending = GST_STATE_NULL;

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
        m_logger.info("inititalize(): Pipeline already initialized!");
        return true;
    }
    m_logger.info("Initializing " + m_parameters.name + " pipeline..");

    const int probe_timeout = 5;   // timeout на каждый probe
    const int max_attempts = 10;   // сколько попыток сделать
    const int reconnect_delay_sec = 2; // задержка между попытками

    for (int attempt = 1; attempt <= max_attempts; ++attempt) {
        m_logger.info("Probe attempt " + std::to_string(attempt) + "/" + std::to_string(max_attempts));

        if (probe_video_stream(probe_timeout)) {
            return true;
        }

        m_logger.warn("Camera stream not found, retrying in " + std::to_string(reconnect_delay_sec) + "s...");
        std::this_thread::sleep_for(std::chrono::seconds(reconnect_delay_sec));
    }

    m_logger.error("Failed to detect camera stream after " + std::to_string(max_attempts) + " attempts!");
    return false;
}

bool UCameraPipeline::start() {
    std::lock_guard<std::mutex> lock(m_pipeline_mutex);

    if (!m_pipeline) {
        m_logger.error("Cannot start pipeline: pipeline is null.");
        return false;
    }

    GstStateChangeReturn ret = gst_element_set_state(m_pipeline, GST_STATE_PLAYING);
    if (ret == GST_STATE_CHANGE_FAILURE) {
        m_logger.error("Failed to set pipeline state to PLAYING.");
        return false;
    }

    m_logger.info("Pipeline started successfully.");
    return true;
}

bool UCameraPipeline::stop() {
    std::lock_guard<std::mutex> lock(m_pipeline_mutex);

    if (!m_pipeline) {
        m_logger.warn("Pipeline is null, nothing to stop.");
        return true;
    }

    GstStateChangeReturn ret = gst_element_set_state(m_pipeline, GST_STATE_PAUSED);
    if (ret == GST_STATE_CHANGE_FAILURE) {
        m_logger.error("Failed to set pipeline state to PAUSED.");
        return false;
    }

    m_logger.info("Pipeline paused successfully.");
    return true;
}

bool UCameraPipeline::destroy()
{
    if (m_is_destroying) {
        m_logger.warn("stop(): function destroy already called!");
        return true;
    }

    if (!m_pipeline) {
        m_logger.warn("Pipeline already destroyed or null.");
        m_is_destroying = false;
        return true;
    }

    m_logger.info("Destroying pipeline (graceful shutdown)...");
    m_is_destroying = true;

    // Отправка eos, чтобы корректно остановить критичные элементы пайплайна
    m_logger.debug("Sending EOS event...");
    if (!gst_element_send_event(m_pipeline, gst_event_new_eos())) {
        m_logger.warn("Failed to send EOS event.");
    }

    GstBus* bus = gst_element_get_bus(m_pipeline);

    constexpr GstClockTime eos_timeout = 5 * GST_SECOND;
    GstMessage* msg = gst_bus_timed_pop_filtered(
        bus,
        eos_timeout,
        static_cast<GstMessageType>(GST_MESSAGE_EOS | GST_MESSAGE_ERROR)
    );

    if (!msg) {
        m_logger.warn("Timeout waiting for EOS message.");
    }
    else {
        switch (GST_MESSAGE_TYPE(msg)) {
            case GST_MESSAGE_EOS:
                m_logger.info("EOS received successfully.");
                break;
            case GST_MESSAGE_ERROR: {
                GError* err = nullptr;
                gchar* debug_info = nullptr;
                gst_message_parse_error(msg, &err, &debug_info);

                m_logger.error(std::string("Error during EOS wait: ") + (err ? err->message : "unknown"));

                if (debug_info) {
                    m_logger.debug(std::string("Debug info: ") + debug_info);
                }

                if (err) g_error_free(err);
                if (debug_info) g_free(debug_info);
                break;
            }
            default:
                break;
        }

        gst_message_unref(msg);
    }
    gst_object_unref(bus);

    m_logger.debug("Setting pipeline state to NULL...");

    // Первевод в null с ожиданием перевода
    GstStateChangeReturn ret = gst_element_set_state(m_pipeline, GST_STATE_NULL);

    if (ret == GST_STATE_CHANGE_FAILURE) {
        m_logger.error("Failed to initiate state change to NULL.");
        m_is_destroying = false;
        return false;
    }

    constexpr GstClockTime null_timeout = 5 * GST_SECOND;
    GstState current = GST_STATE_VOID_PENDING;
    GstState pending = GST_STATE_VOID_PENDING;
    ret = gst_element_get_state(
        m_pipeline,
        &current,
        &pending,
        null_timeout
    );

    if (ret == GST_STATE_CHANGE_ASYNC) {
        m_logger.error("Timeout waiting for pipeline to reach NULL.");
        m_is_destroying = false;
        return false;
    }
    if (ret == GST_STATE_CHANGE_FAILURE) {
        m_logger.error("State change to NULL failed.");
        m_is_destroying = false;
        return false;
    }
    if (current != GST_STATE_NULL) {
        m_logger.error("Pipeline did not reach NULL state. Current state: " +
            std::string(gst_element_state_get_name(current)));
        m_is_destroying = false;
        return false;
    }

    m_logger.info("Pipeline reached NULL state.");

    // очистка полей
    m_tees.clear();
    m_webrtc_sessions.clear();

    gst_object_unref(m_pipeline);
    m_pipeline = nullptr;
    m_has_initialized = false;

    m_logger.info("Pipeline destroyed successfully.");
    m_is_destroying = false;

    return true;
}

void UCameraPipeline::restart_loop() {
    m_logger.info("restart_loop(): Starting restart loop for " + m_parameters.name);

    while (m_is_restarting) {
        m_logger.info("restart_loop(): Attempt restart #" + std::to_string(m_restart_attempts + 1));

        bool success = true;

        if (!destroy()) {
            m_logger.error("restart_loop(): destroy() pipeline failed");
            success = false;
        }

        if (success && !initialize()) {
            m_logger.error("restart_loop(): initialize() pipeline failed");
            success = false;
        }

        if (success && !start()) {
            m_logger.error("restart_loop(): start() pipeline failed");
            success = false;
        }

        if (success)
        {
            m_logger.info("restart_loop(): Pipeline restarted successfully");

            // сброс backoff
            m_restart_attempts = 0;
            m_backoff_ms = 1000;
            m_is_restarting = false;

            return;
        }

        m_restart_attempts++;

        m_logger.warn("restart_loop(): Retry in " + std::to_string(m_backoff_ms) + " ms");

        std::this_thread::sleep_for(std::chrono::milliseconds(m_backoff_ms));

        m_backoff_ms = std::min(m_backoff_ms * 2, m_max_backoff_ms);
    }

    m_logger.info("restart_loop(): Restart loop stopped");
    m_is_restarting = false;
}

void UCameraPipeline::restart_async() {
    if (m_is_restarting.exchange(true)) {
        m_logger.warn("restart_async(): Restart already in progress");
        return;
    }

    m_restart_thread = std::thread(&UCameraPipeline::restart_loop, this);
}

void UCameraPipeline::stop_restart_thread() {
    m_is_restarting = false;
}

bool UCameraPipeline::probe_video_stream(int timeout_sec) {
    m_logger.debug("Initializing probe pipeline...");

    auto pipeline = gst_pipeline_new("probe-pipeline");
    auto src = gst_element_factory_make("rtspsrc", nullptr);
    auto decoder = gst_element_factory_make("mppvideodec", nullptr);
    auto sink = gst_element_factory_make("fakesink", nullptr);

    if (!pipeline || !src || !decoder || !sink) {
        m_logger.error("Failed to create probe pipeline elements.");
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
        &m_logger
    };

    g_signal_connect(src, "pad-added", G_CALLBACK(on_rtsp_pad_added), &ctx);

    GstPad* dec_src = gst_element_get_static_pad(decoder, "src");

    gst_pad_add_probe(dec_src, GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM, on_decoder_caps, &ctx, nullptr);
    gst_object_unref(dec_src);

    // Запуск пайплайна
    m_logger.debug("Setting probe pipeline to PLAYING state...");
    gst_element_set_state(pipeline, GST_STATE_PLAYING);

    GstBus* bus = gst_element_get_bus(pipeline);
    gint64 deadline = g_get_monotonic_time() + timeout_sec * G_TIME_SPAN_SECOND;
    while (!m_probe.ready() && g_get_monotonic_time() < deadline) {
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

            m_logger.error(oss.str());

            if (err) g_error_free(err);
            if (debug_info) g_free(debug_info);

            gst_message_unref(msg);
            break;
        }

        gst_message_unref(msg);
    }

    gst_object_unref(bus);

    gst_element_set_state(pipeline, GST_STATE_NULL);
    gst_object_unref(pipeline);

    if (!m_probe.ready()) {
        m_logger.warn("Probe failed: stream not ready.");
        return false;
    }

    std::ostringstream oss;
    oss << "Probe succeeded:\n\tcodec=" << m_probe.codec_name << "\n\twidth=" << m_probe.width << "\n\theight=" << m_probe.height;
    m_logger.info(oss.str());
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
    std::ostringstream oss_error;

    auto ses_it = m_webrtc_sessions.find(client_id);
    if (ses_it != m_webrtc_sessions.end()) {
        oss_error << "Cannot close session with " << client_id << ": session doesn't exist!";
        description = oss_error.str();
        return false;
    }
    try {
        m_webrtc_sessions.erase(client_id);
        return true;
    }
    catch (const std::exception& e) {
        oss_error << "Error when delete session with " << client_id 
                  << " at " << m_parameters.name << " pipeline: " << e.what();
        description = oss_error.str();
        return false;
    }
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
