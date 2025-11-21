#include <iostream>
#include <thread>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <condition_variable>
#include <vector>
#include <atomic>
#include <chrono>
#include <opencv2/opencv.hpp>

#include <gst/gst.h>
#include <gst/video/video.h>
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>

extern "C" {
	#include <libavformat/avformat.h>
	#include <libavcodec/avcodec.h>
	#include <libswscale/swscale.h>
	#include <libavutil/imgutils.h>
}

#include "drm_frame.h"
#include "safe_buffers.h"

namespace varan {
namespace neural {

	using CFrameCallback = std::function<void(std::string& name, std::unique_ptr<FDrmFrame>)>;

	struct FCameraOptions {
		std::string name;
		std::string rtsp_url;
		bool b_use_udp;
		bool b_use_buffer;
		bool b_low_latency;
		int framerate;
		int probe_size;
		int analyze_duration;
		int reconnect_delay;
		size_t buff_reading_size;
	};

	void print_codec_params(const AVCodec* codec);

	struct FMpegContexts {
		AVFormatContext* fmt_ctx = nullptr;
		AVCodecContext* codec_ctx = nullptr;
		SwsContext* sws_ctx = nullptr;
		int video_stream_index = -1;

		void free();
	};

	struct FInternalCameraOpts {
		int framerate;
		int width;
		int height;
		AVPixelFormat format;
	};

	class UCamera {

	public:
		explicit UCamera(const FCameraOptions& options);

		~UCamera();

		bool initialize();

		bool start();

		void stop();

		void restart();

		void contexts_init(FMpegContexts& cam_contexts);

		void set_frame_callback(CFrameCallback callback);

		bool create_gst_pipeline();

	private:
		FCameraOptions m_options;
		FInternalCameraOpts m_internal_options;

		CFrameCallback m_frame_callback;

		std::atomic<bool> m_running;
		std::atomic<bool> m_error;
		bool m_initialized;
		bool m_gst_initialized;

		std::thread m_reading_thread;
		std::thread m_decode_thread;

		FMpegContexts m_mpeg_context;

		// Ожидающая очередь для хранения фреймов
		using UniquePacket = std::unique_ptr<AVPacket, std::function<void(AVPacket*)>>;
		USafeQueue<UniquePacket> m_buffer;

		// Поля для GStream
		using TUniqueGst = std::unique_ptr<GstElement, decltype(&gst_object_unref)>;
		TUniqueGst m_pipeline;
		TUniqueGst m_appsrc;
		TUniqueGst m_webrtc;

		AVCodec* find_codec(AVCodecID codec_id, AVCodecContext* codec_ctx);

		void crop_codec_context(AVCodecContext* codec_ctx);

		void init_hw_device(AVCodecContext* codec_ctx);

		static enum AVPixelFormat get_hw_format_callback(AVCodecContext* ctx, const enum AVPixelFormat* pix_fmts);

		void read_frames(FMpegContexts& mpeg_context);

		void decode_frames(FMpegContexts& mpeg_context);

	};

} // namespace neural
} // namespace varan