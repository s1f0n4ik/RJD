#include "camera.h"
#include "console_utility.h"
#include <libavutil/hwcontext_drm.h>
#include <gst/allocators/allocators.h>

#include <ranges>

namespace varan {
namespace neural {

	std::string get_ffmpeg_error(int ret) {
		char errbuf[256];
		av_strerror(ret, errbuf, sizeof(errbuf));
		return errbuf;
	}

	void FMpegContexts::free() {
		if (!sws_ctx) sws_freeContext(sws_ctx);
		if (!codec_ctx) avcodec_free_context(&codec_ctx);
		if (!fmt_ctx) avformat_close_input(&fmt_ctx);
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


	void print_codec_params(const AVCodec* codec) {
		if (codec) {
			std::cout << color::green
				<< "[UCamera] Using codec: " << codec->name << " (id: " << codec->id << "); formats: "
				<< get_pix_fmts_string(codec->pix_fmts)
				<< color::reset << std::endl;
		}
	}

	UCamera::UCamera(const FCameraOptions& options) 
		: m_running(false)
		, m_error(false)
		, m_initialized(false)
		, m_gst_initialized(false)
		, m_packets_buffer(options.buff_reading_size)
		, m_frames_buffer(options.buff_reading_size)
		, m_pipeline(nullptr, &gst_object_unref)
		, m_appsrc(nullptr, &gst_object_unref)
		, m_webrtc(nullptr, &gst_object_unref)
	{
		m_options = options;
		static std::once_flag ffmpeg_init;
		std::call_once(ffmpeg_init, []() {
			av_log_set_level(AV_LOG_ERROR);
			avformat_network_init();
		});
	};

	UCamera::~UCamera() { stop(); }

	bool UCamera::initialize() {
		if (m_initialized) return true;

		try {
			contexts_init(m_mpeg_context);
			m_initialized = true;
			return true;
		}
		catch (const std::runtime_error& error) {
			std::cerr << error.what();
			m_mpeg_context.free();
			return false;
		}
	}

	bool UCamera::start() {
		if (m_running) return false;
		m_running = true;

		m_reading_thread = std::thread(&UCamera::read_frames, this, std::ref(m_mpeg_context));
		m_decode_thread = std::thread(&UCamera::decode_frames, this, std::ref(m_mpeg_context));
		m_push_thread = std::thread(&UCamera::push_frames_to_gst_pipeline, this);

		return true;
	}

	void UCamera::stop() {
		if (!m_running) return;
		m_running = false;

		if (m_reading_thread.joinable()) m_reading_thread.join();
		if (m_decode_thread.joinable()) m_decode_thread.join();

		m_mpeg_context.free();
	}

	void UCamera::set_frame_callback(CFrameCallback callback) {
		m_frame_callback = std::move(callback);
	}

	void UCamera::contexts_init(FMpegContexts& cam_contexts) {
		//av_log_set_level(AV_LOG_DEBUG);

		AVDictionary* opts = nullptr;

		// Устанавливаем флаги FFMpeg для уменьшении задержки потока
		if (m_options.b_use_udp) {
			av_dict_set(&opts, "rtsp_transport", "udp", 0);
		}
		else {
			av_dict_set(&opts, "rtsp_transport", "tcp", 0);
		}
		if (m_options.b_use_buffer) av_dict_set(&opts, "fflags", "nobuffer", 0);
		if (m_options.b_low_latency) av_dict_set(&opts, "flags", "low_delay", 0);

		// Быстрый старт 
		{
			char buf[32];
			snprintf(buf, sizeof(buf), "%d", m_options.probe_size);
			av_dict_set(&opts, "probesize", buf, 0);
			snprintf(buf, sizeof(buf), "%d", m_options.analyze_duration);
			av_dict_set(&opts, "analyzeduration", buf, 0);
		}

		int ret = avformat_open_input(&cam_contexts.fmt_ctx, m_options.rtsp_url.c_str(), nullptr, &opts);
		if (ret < 0) {
			char errbuf[256];
			av_strerror(ret, errbuf, sizeof(errbuf));
			av_dict_free(&opts);
			throw std::runtime_error(errbuf);
		}
		av_dict_free(&opts);

		if ((ret = avformat_find_stream_info(cam_contexts.fmt_ctx, nullptr)) < 0) {
			throw std::runtime_error("avformat_find_stream_info failed\n");
		}

		for (unsigned i = 0; i < cam_contexts.fmt_ctx->nb_streams; ++i) {
			if (cam_contexts.fmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
				cam_contexts.video_stream_index = i;
				break;
			}
		}
		if (cam_contexts.video_stream_index < 0) {
			throw std::runtime_error("no video stream\n");
		}

		AVCodecParameters* codecpar = cam_contexts.fmt_ctx->streams[cam_contexts.video_stream_index]->codecpar;
		const AVCodec* codec = find_codec(codecpar->codec_id, cam_contexts.codec_ctx);
		if (!codec) {
			throw std::runtime_error("codec not found\n");
		}

		cam_contexts.codec_ctx = avcodec_alloc_context3(codec);
		if (!cam_contexts.codec_ctx) {
			throw std::runtime_error("avcodec_alloc_context3 failed\n");
		}

		if ((ret = avcodec_parameters_to_context(cam_contexts.codec_ctx, codecpar)) < 0) {
			throw std::runtime_error("avcodec_parameters_to_context failed\n");
		}

		cam_contexts.codec_ctx->thread_count = 1;
		cam_contexts.codec_ctx->delay = 0;

		// Делаем кроп при использовании аппаратного кодека
		auto hard_codec_names = {"h263_rkmpp", "h264_rkmpp", "hevc_rkmpp", "h263_v4l2m2m", "h264_v4l2m2m", "hevc_v4l2m2m"};
		const char* codec_name = cam_contexts.codec_ctx->codec->name;
		bool found = std::any_of(std::begin(hard_codec_names), std::end(hard_codec_names),
			[codec_name](const char* name) {
				return std::strcmp(name, codec_name) == 0;
			});
		if (found) {
			crop_codec_context(cam_contexts.codec_ctx);
			init_hw_device(cam_contexts.codec_ctx);
		}

		if ((ret = avcodec_open2(cam_contexts.codec_ctx, codec, nullptr)) < 0) {
			throw std::runtime_error("avcodec_open2 failed\n");
		}

	}

	void UCamera::init_hw_device(AVCodecContext* codec_ctx) {
		if (!codec_ctx) {
			std::ostringstream oss;
			oss << color::red << "[UCamera] Error in init_hw_device: codec context is null!\n" << color::reset;
			throw std::runtime_error(oss.str());
		}

		AVBufferRef* hw_device_ctx = nullptr;
		const char* device_name = "/dev/dri/renderD128";
		int ret = av_hwdevice_ctx_create(&hw_device_ctx, AV_HWDEVICE_TYPE_DRM, device_name, nullptr, 0);
		if (ret < 0) {
			char errbuf[256];
			av_strerror(ret, errbuf, sizeof(errbuf));
			std::ostringstream oss;
			oss << color::red << "[UCamera] Failed to create DRM device for " << codec_ctx->codec->name
				<< ": " << errbuf << color::reset << std::endl;
			throw std::runtime_error(oss.str());
		}
		codec_ctx->hw_device_ctx = av_buffer_ref(hw_device_ctx);
		av_buffer_unref(&hw_device_ctx);

		// Создаем hwframe_ctx
		AVHWFramesContext* frames_ctx = nullptr;
		AVBufferRef* frames_ref = av_hwframe_ctx_alloc(codec_ctx->hw_device_ctx);
		if (!frames_ref) {
			std::ostringstream oss;
			oss << color::red << "[UCamera] Cannot create av_hwframe_ctx_alloc!\n" << color::reset << std::endl;
			throw std::runtime_error(oss.str());
		}

		frames_ctx = (AVHWFramesContext*)frames_ref->data;
		frames_ctx->format = AV_PIX_FMT_DRM_PRIME;
		frames_ctx->sw_format = AV_PIX_FMT_NV12;
		frames_ctx->width = codec_ctx->width;
		frames_ctx->height = codec_ctx->height;

		m_internal_options.format = frames_ctx->sw_format;

		// Создать контекст кадров
		int err = av_hwframe_ctx_init(frames_ref);
		if (err < 0) {
			char errbuf[256];
			av_strerror(err, errbuf, sizeof(errbuf));
			std::ostringstream oss;
			oss << color::red << "[UCamera] Error in creating hw_frames_ctx: " << errbuf << color::reset << std::endl;
			throw std::runtime_error(oss.str());
		}

		// Назначить hw_frames_ctx
		codec_ctx->hw_frames_ctx = av_buffer_ref(frames_ref);
		av_buffer_unref(&frames_ref);

		codec_ctx->get_format = UCamera::get_hw_format_callback;
	}

	void UCamera::read_frames(FMpegContexts& mpeg_context) {
		while (m_running) {
			auto rtp_packet = UniquePacket(
				av_packet_alloc(), 
				[](AVPacket* ptr) { av_packet_free(&ptr); }
			);

			while (m_running) {
				auto ret = av_read_frame(mpeg_context.fmt_ctx, rtp_packet.get());
				if (ret < 0) {
					std::cerr << color::red << "[UCamera: read thread] Error with av_read_frame: "
						      << get_ffmpeg_error(ret) << "; Reconnect!" << color::reset << std::endl;
					break;
				}

				if (rtp_packet->stream_index != mpeg_context.video_stream_index) {
					av_packet_unref(rtp_packet.get());
					continue;
				}

				auto copy = UniquePacket(
					av_packet_alloc(),
					[](AVPacket* ptr) { av_packet_free(&ptr); }
				);
				ret = av_packet_ref(copy.get(), rtp_packet.get());
				if (ret < 0) {
					std::cerr << color::red << "[UCamera: read thread] Error with av_packet_ref: " 
						      << get_ffmpeg_error(ret) << color::reset << std::endl;
					continue;
				}
				av_packet_unref(rtp_packet.get());

				m_packets_buffer.push(std::move(copy));
			}
			std::cerr << color::red << "[UCamera: read thread] Read thread has ended!" << color::reset << std::endl;
			std::cerr << color::yellow << "[UCamera: read thread] Read thread resetting!" << color::reset << std::endl;
		}
	}

	void UCamera::decode_frames(FMpegContexts& mpeg_context) {
		while (m_running) {
			// Достаем из очереди пакет
			auto rtp_packet = m_packets_buffer.wait_and_pop();

			auto ret = avcodec_send_packet(mpeg_context.codec_ctx, rtp_packet.get());
			if (ret < 0) {
				std::cerr << color::red << "[UCamera: decode thread] Error with avcodec_send_packet: " 
					      << get_ffmpeg_error(ret) << color::reset << std::endl;
				continue;
			}

			auto src_frame = std::unique_ptr<AVFrame, std::function<void(AVFrame*)>>(
				av_frame_alloc(), 
				[](AVFrame* f) { av_frame_free(&f); }
			);

			while (ret >= 0) {
				ret = avcodec_receive_frame(mpeg_context.codec_ctx, src_frame.get());
				// Корректное завершение цикла
				if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;

				if (ret < 0) {
					std::cerr << color::red << "[UCamera: decode thread] Error with avcodec_receive_frame: "
						      << get_ffmpeg_error(ret) << color::reset << std::endl;
					break;
				}

				// Проверка на то, какой буфер используется.
				if (src_frame->format == AV_PIX_FMT_DRM_PRIME) {
					auto* desc = (AVDRMFrameDescriptor*)src_frame->data[0];

					int offset[4] = {};
					int pitch[4] = {};
					int format;

					for (int i = 0; i < desc->nb_layers; i++) {
						const auto& layer = desc->layers[i];
						format = layer.format;

						for (int j = 0; j < layer.nb_planes; j++) {
							offset[j] = layer.planes[j].offset;
							pitch[j] = layer.planes[j].pitch;
						}
					}

					// Переводит pts в timestamp ms
					AVRational time_base = mpeg_context.codec_ctx->time_base;
					int64_t pts = src_frame.get()->pts;

					// Создаем конечную структуру фрейма
					auto drf_frame = FDrmFrame{
						desc->objects[0].fd,
						src_frame->width,
						src_frame->height,
						format,
						offset,
						pitch,
						desc->nb_layers,
						pts
					};

					m_frames_buffer.push(std::make_unique<FDrmFrame>(std::move(drf_frame)));

					//if (m_frame_callback) {
					//	m_frame_callback(m_options.name, std::make_unique<FDrmFrame>(std::move(drf_frame)));
					//}
				}
				else {
					continue;
				}
			}
		}
	}

	void UCamera::crop_codec_context(AVCodecContext* codec_ctx) {
		int cropped_width = codec_ctx->width & ~15;
		int cropped_height = codec_ctx->height & ~15;

		int coded_cropped_width = (codec_ctx->width + 15) & ~15;
		int coded_cropped_height = (codec_ctx->height + 15) & ~15;

		std::cout << color::green
			<< "[FFmpeg Init] Cropping frame to " << cropped_width << "x" << cropped_height
			<< " (original " << codec_ctx->width << "x" << codec_ctx->height << ")\n"
			<< color::reset;

		codec_ctx->width = cropped_width;
		codec_ctx->height = cropped_height;

		codec_ctx->coded_width = coded_cropped_width;
		codec_ctx->coded_height = coded_cropped_height;
	}

	AVCodec* UCamera::find_codec(AVCodecID codec_id, AVCodecContext* codec_ctx) {
		using entry = std::pair<std::string, AVHWDeviceType>;
		std::map<AVCodecID, std::array<entry, 2>> codec_map {
			{AV_CODEC_ID_H264, {entry{"h264_rkmpp", AV_HWDEVICE_TYPE_DRM}, entry{"h264_v4l2m2m", AV_HWDEVICE_TYPE_DRM}}},
			{AV_CODEC_ID_HEVC, {entry{"hevc_rkmpp", AV_HWDEVICE_TYPE_DRM}, entry{"hevc_v4l2m2m", AV_HWDEVICE_TYPE_DRM}}},
		};

		AVCodec* codec = nullptr;
		for (const auto& [key, types] : codec_map) {
			if (key == codec_id) {
				for (const auto& type : types) {
					codec = avcodec_find_decoder_by_name(type.first.c_str());
					if (codec) {
						print_codec_params(codec);
						return codec;
					}
				}
			}
		}
		codec = avcodec_find_decoder(codec_id);
		print_codec_params(codec);
		return codec;
	}

	enum AVPixelFormat UCamera::get_hw_format_callback(AVCodecContext* ctx, const enum AVPixelFormat* pix_fmts) {
		for (const enum AVPixelFormat* p = pix_fmts; *p != -1; p++) {
			if (*p == AV_PIX_FMT_DRM_PRIME)
				return *p;
		}
		std::cerr << color::red << "Failed to get HW surface format.\n" << color::reset;
		return AV_PIX_FMT_NONE;
	}

	// ======== GStreaming

	bool UCamera::create_gst_pipeline()
	{
		if (m_gst_initialized) {
			return true;
		}

		gst_init(nullptr, nullptr);

		std::cout << color::yellow << "[UCamera] Creating gst streaming for camera " << m_options.name << "..." << color::reset << std::endl;

		std::ostringstream oss_error;
		if (!m_mpeg_context.codec_ctx) {
			oss_error << color::red << "[UCamera] Error in create_gst_pipeline(): no initialized codec!" << color::reset << std::endl;
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
			encoder = "mpph265enc"; encoding_name = "H265"; parse = "h265parse"; pay = "rtph265pay";
		}
		else {
			oss_error << color::red << "[UCamera] Error in create_gst_pipeline(): an unsupported codec is being used: " << codec_name << "!" << color::reset << std::endl;
			throw std::runtime_error(oss_error.str());
		}

		std::ostringstream oss_pipeline_desc;
		oss_pipeline_desc << "appsrc name=src_" << m_options.name << " is-live=true format=time ! "
			<< "video/x-raw,format=" << format << ",width=" << width << ",height=" << height << ",framerate=" << m_options.framerate << "/1 ! "
			<< "queue ! "
			<< "v4l2convert output-io-mode=dmabuf-import ! "
			<< "queue ! "
			<< encoder << " extra-controls=\"encode,frame_level_rate_control_enable=1\" ! "
			<< parse <<" ! "
			<< pay << " config-interval=1 pt=96 ! "
			<< "application/x-rtp,media=video,encoding-name=" << encoding_name << ",payload=96 ! "
			<< "webrtcbin name=webrtc_" << m_options.name;

		GError* err = nullptr;
		m_pipeline = TUniqueGst(gst_parse_launch(oss_pipeline_desc.str().c_str(), &err), &gst_object_unref);
		if (!m_pipeline) {
			std::cerr << "Failed to create pipeline: " << err->message << std::endl;
			return false;
		}

		m_appsrc = TUniqueGst(gst_bin_get_by_name(GST_BIN(m_pipeline.get()), ("src_" + m_options.name).c_str()), &gst_object_unref);
		m_webrtc = TUniqueGst(gst_bin_get_by_name(GST_BIN(m_pipeline.get()), ("webrtc_" + m_options.name).c_str()), &gst_object_unref);

		gst_element_set_state(m_pipeline.get(), GST_STATE_PLAYING);

		std::cout << color::green << "[UCamera] Creation gst streaming for camera " << m_options.name << " was successful!" << color::reset << std::endl;

		m_gst_initialized = true;
		return m_gst_initialized;
	}

	void UCamera::push_frames_to_gst_pipeline()
	{
		if (!m_appsrc) {
			std::ostringstream oss;
			oss << color::red << "[UCamera push_thread] No appsrc initis!" << color::reset << std::endl;
			throw std::runtime_error(oss.str());
		}

		while (m_running) {

			GstBuffer* buffer = gst_buffer_new();
			if (!buffer) {
				std::this_thread::sleep_for(std::chrono::microseconds(1000));
				continue;
			}

			GstAllocator* allocator = gst_dmabuf_allocator_new();

			const auto frame = m_frames_buffer.wait_and_pop();

			// Предположим один fd, один план и offset == 0
			if (frame->num_planes == 1 && frame->offset[0] == 0) {
				size_t size = frame->pitch[0] * frame->height;
				GstMemory* mem = gst_dmabuf_allocator_alloc(allocator, frame->fd, size);
				if (!mem) {
					gst_buffer_unref(buffer);
					continue;
				}
				gst_buffer_append_memory(buffer, mem);
			}
			else {
				// Несколько планов с offset — используем gst_memory_new_wrapped
				for (int i = 0; i < frame->num_planes; ++i) {
					size_t plane_size = frame->pitch[i] * frame->height;
					GstMemory* mem = gst_memory_new_wrapped(
						GST_MEMORY_FLAG_READONLY,
						nullptr,
						plane_size,
						frame->offset[i],
						plane_size,
						(gpointer)(intptr_t)frame->fd,
						nullptr
					);
					if (!mem) {
						gst_buffer_unref(buffer);
						continue;
					}
					gst_buffer_append_memory(buffer, mem);
				}
			}

			GST_BUFFER_PTS(buffer) = frame->pts;

			GstFlowReturn ret = gst_app_src_push_buffer(GST_APP_SRC(m_appsrc.get()), buffer);

			if (ret != GST_FLOW_OK) {
				gst_buffer_unref(buffer);
				continue;
			}
		}
	}

} // namespace neural
} // namespace varan