#include "nvr/stream-probe.h"

#include <algorithm>
#include <atomic>
#include <string>

#include <gst/gst.h>
#include <gst/rtsp/gstrtsptransport.h>

namespace varan {
namespace nvr {

	namespace {

		struct FProbeContext {
			GstElement* pipeline = nullptr;
			GstElement* decoder = nullptr;
			GstElement* sink = nullptr;
			ULogger* logger = nullptr;

			std::string codec;
			int width = 0;
			int height = 0;
			int fps = 0;

			std::atomic<bool> got_codec{ false };
			std::atomic<bool> got_video_info{ false };

			bool ready() const { return got_codec && got_video_info; }
		};

		// Капсы декодера: отсюда берутся размер и частота кадров
		GstPadProbeReturn on_decoder_caps(GstPad*, GstPadProbeInfo* info, gpointer user_data) {
			auto* ctx = static_cast<FProbeContext*>(user_data);

			if (ctx->got_video_info) {
				return GST_PAD_PROBE_REMOVE;
			}

			if (!(info->type & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM)) {
				return GST_PAD_PROBE_OK;
			}

			GstEvent* event = gst_pad_probe_info_get_event(info);
			if (!event || GST_EVENT_TYPE(event) != GST_EVENT_CAPS) {
				return GST_PAD_PROBE_OK;
			}

			GstCaps* caps = nullptr;
			gst_event_parse_caps(event, &caps);

			if (!caps || gst_caps_is_empty(caps)) {
				return GST_PAD_PROBE_OK;
			}

			const GstStructure* structure = gst_caps_get_structure(caps, 0);

			int width = 0;
			int height = 0;
			if (!gst_structure_get_int(structure, "width", &width)
				|| !gst_structure_get_int(structure, "height", &height)) {
				return GST_PAD_PROBE_OK;
			}

			ctx->width = width;
			ctx->height = height;

			// Частота приходит дробью; знаменатель бывает нулевым на переменной частоте
			gint fps_n = 0;
			gint fps_d = 0;
			if (gst_structure_get_fraction(structure, "framerate", &fps_n, &fps_d) && fps_d > 0) {
				ctx->fps = fps_n / fps_d;
			}

			ctx->got_video_info = true;

			if (ctx->logger) {
				ctx->logger->debug("probe_stream(): " + std::to_string(width) + "x" + std::to_string(height)
					+ " @ " + std::to_string(ctx->fps));
			}

			return GST_PAD_PROBE_REMOVE;
		}

		void on_rtsp_pad_added(GstElement*, GstPad* pad, gpointer user_data) {
			auto* ctx = static_cast<FProbeContext*>(user_data);
			auto* logger = ctx->logger;

			GstCaps* caps = gst_pad_get_current_caps(pad);
			if (!caps) {
				caps = gst_pad_query_caps(pad, nullptr);
			}

			if (!caps || gst_caps_is_empty(caps)) {
				return;
			}

			const GstStructure* structure = gst_caps_get_structure(caps, 0);
			const gchar* encoding = gst_structure_get_string(structure, "encoding-name");

			if (!encoding) {
				if (logger) logger->warn("probe_stream(): caps found but encoding-name missing");
				gst_caps_unref(caps);
				return;
			}

			const bool is_h264 = g_strcmp0(encoding, "H264") == 0;
			const bool is_h265 = g_strcmp0(encoding, "H265") == 0;

			if (!is_h264 && !is_h265) {
				if (logger) logger->warn(std::string("probe_stream(): unsupported codec ") + encoding);
				gst_caps_unref(caps);
				return;
			}

			ctx->codec = encoding;
			ctx->got_codec = true;

			GstElement* depay = gst_element_factory_make(is_h264 ? "rtph264depay" : "rtph265depay", nullptr);
			GstElement* parse = gst_element_factory_make(is_h264 ? "h264parse" : "h265parse", nullptr);

			if (!depay || !parse) {
				if (logger) logger->error("probe_stream(): failed to create depay/parse elements");
				gst_caps_unref(caps);
				return;
			}

			gst_bin_add_many(GST_BIN(ctx->pipeline), depay, parse, nullptr);
			gst_element_sync_state_with_parent(depay);
			gst_element_sync_state_with_parent(parse);

			if (!gst_element_link_many(depay, parse, ctx->decoder, ctx->sink, nullptr)) {
				if (logger) logger->error("probe_stream(): failed to link depay -> parse -> decoder -> sink");
				gst_caps_unref(caps);
				return;
			}

			GstPad* sink_pad = gst_element_get_static_pad(depay, "sink");
			if (sink_pad) {
				gst_pad_link(pad, sink_pad);
				gst_object_unref(sink_pad);
			}

			gst_caps_unref(caps);
		}

		// Признаки те же, по которым камера разбирает ошибки своей шины
		EProbeReason classify_error(const std::string& message) {
			std::string lower = message;
			std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);

			if (lower.find("unauthorized") != std::string::npos
				|| lower.find("401") != std::string::npos) {
				return EProbeReason::AUTH;
			}

			if (lower.find("not found") != std::string::npos
				|| lower.find("404") != std::string::npos) {
				return EProbeReason::NO_STREAM;
			}

			if (lower.find("no route") != std::string::npos
				|| lower.find("could not connect") != std::string::npos
				|| lower.find("connection refused") != std::string::npos
				|| lower.find("could not open resource") != std::string::npos) {
				return EProbeReason::UNREACHABLE;
			}

			if (lower.find("timeout") != std::string::npos
				|| lower.find("timed out") != std::string::npos) {
				return EProbeReason::TIMEOUT;
			}

			return EProbeReason::UNREACHABLE;
		}

		std::string reason_details(EProbeReason reason) {
			switch (reason) {
			case EProbeReason::AUTH:        return "Camera rejected the login or password";
			case EProbeReason::UNREACHABLE: return "Camera doesn't answer at this address and port";
			case EProbeReason::NO_STREAM:   return "Camera answers, but has no such substream";
			case EProbeReason::TIMEOUT:     return "Connected, but no frame arrived in time";
			case EProbeReason::DECODER:     return "Device error: cannot create gstreamer elements";
			default:                        return "";
			}
		}

	} // namespace

	FStreamProbe probe_stream(const std::string& rtsp_url, int timeout_sec, ULogger* logger) {
		FStreamProbe result;

		if (logger) logger->debug("probe_stream(): " + rtsp_url);

		GstElement* pipeline = gst_pipeline_new("stream-probe");
		GstElement* src = gst_element_factory_make("rtspsrc", nullptr);
		GstElement* decoder = gst_element_factory_make("mppvideodec", nullptr);
		GstElement* sink = gst_element_factory_make("fakesink", nullptr);

		if (!pipeline || !src || !decoder || !sink) {
			// Без имени фабрики причина неотличима: нет плагина, ABI, чёрный список реестра
			std::string missing;
			if (!pipeline) missing += " stream-probe";
			if (!src)      missing += " rtspsrc";
			if (!decoder)  missing += " mppvideodec";
			if (!sink)     missing += " fakesink";

			if (logger) logger->error("probe_stream(): cannot create elements, missing:" + missing);

			if (sink)     gst_object_unref(sink);
			if (decoder)  gst_object_unref(decoder);
			if (src)      gst_object_unref(src);
			if (pipeline) gst_object_unref(pipeline);

			result.reason = EProbeReason::DECODER;
			result.details = reason_details(result.reason);
			return result;
		}

		g_object_set(src,
			"location", rtsp_url.c_str(),
			"protocols", GST_RTSP_LOWER_TRANS_TCP,
			"latency", 0,
			"timeout", static_cast<guint64>(timeout_sec) * G_USEC_PER_SEC,
			nullptr);

		gst_bin_add_many(GST_BIN(pipeline), src, decoder, sink, nullptr);

		FProbeContext ctx;
		ctx.pipeline = pipeline;
		ctx.decoder = decoder;
		ctx.sink = sink;
		ctx.logger = logger;

		g_signal_connect(src, "pad-added", G_CALLBACK(on_rtsp_pad_added), &ctx);

		GstPad* decoder_src = gst_element_get_static_pad(decoder, "src");
		gst_pad_add_probe(decoder_src, GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM, on_decoder_caps, &ctx, nullptr);
		gst_object_unref(decoder_src);

		gst_element_set_state(pipeline, GST_STATE_PLAYING);

		/*
			Шину читаем сами: наблюдатель на GMainLoop здесь не нужен и был бы
			лишней связью с камерой — проба живёт на потоке запроса и умирает
			вместе с ним.
		*/
		GstBus* bus = gst_element_get_bus(pipeline);
		const gint64 deadline = g_get_monotonic_time() + static_cast<gint64>(timeout_sec) * G_TIME_SPAN_SECOND;

		while (!ctx.ready()) {
			const gint64 left = deadline - g_get_monotonic_time();
			if (left <= 0) break;

			GstMessage* message = gst_bus_timed_pop_filtered(
				bus,
				static_cast<GstClockTime>(std::min<gint64>(left, 200 * G_TIME_SPAN_MILLISECOND)) * GST_USECOND,
				static_cast<GstMessageType>(GST_MESSAGE_ERROR | GST_MESSAGE_EOS)
			);

			if (!message) continue;

			if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
				GError* error = nullptr;
				gchar* debug = nullptr;
				gst_message_parse_error(message, &error, &debug);

				const std::string text = error ? error->message : "unknown";
				if (logger) logger->warn("probe_stream(): " + text
					+ " | debug: " + std::string(debug ? debug : "none"));

				result.reason = classify_error(text);

				if (error) g_error_free(error);
				if (debug) g_free(debug);
			}
			else {
				// Поток кончился, не начавшись
				result.reason = EProbeReason::NO_STREAM;
			}

			gst_message_unref(message);
			break;
		}

		gst_object_unref(bus);

		gst_element_set_state(pipeline, GST_STATE_NULL);
		gst_element_get_state(pipeline, nullptr, nullptr, 3 * GST_SECOND);
		gst_object_unref(pipeline);

		if (ctx.ready()) {
			result.ok = true;
			result.codec = ctx.codec;
			result.width = ctx.width;
			result.height = ctx.height;
			result.fps = ctx.fps;

			if (logger) logger->info("probe_stream(): " + result.codec + " "
				+ std::to_string(result.width) + "x" + std::to_string(result.height));

			return result;
		}

		// Ошибки не было, а кадр не пришёл — это таймаут, а не отказ камеры
		if (result.reason == EProbeReason::NONE) {
			result.reason = EProbeReason::TIMEOUT;
		}

		result.details = reason_details(result.reason);
		return result;
	}

} // namespace nvr
} // namespace varan
