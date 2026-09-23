#pragma once

#include <chrono>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <opencv2/opencv.hpp>

#include "core/image-handler.h"
#include "neural/video-stream.h"

namespace varan {
namespace neural {

	// Размещение тайлов за тик; общий указатель живёт вместе с кадром в очереди инференса
	using FCanvasInfo = std::shared_ptr<const std::vector<FTilePlacement>>;
	using FCanvasSink = std::function<void(cv::Mat rgba, FCanvasInfo tiles)>;
	using FSnapshotSink = std::function<void(cv::Mat rgba)>;

	// Собирает полотно размером с вход модели из тайлов камер по общему тику
	class UCanvasComposer : public UImageHandler {
	public:
		UCanvasComposer(
			birdview::UEGLContextManager* context,
			FFrameStorage<IFrame>* storage,
			int width,
			int height,
			const FVideoStream& stream,
			FCanvasSink sink,
			ULogger::ELoggerLevel level = ULogger::ELoggerLevel::DEBUG,
			const std::string& name = "CanvasComposer"
		);

		~UCanvasComposer() override;

		bool start(int fps);
		void stop();

		// Новая раскладка применяется на следующем тике; размер полотна не меняется
		void set_stream(const FVideoStream& stream);
		FVideoStream stream() const;

		int width() const { return m_width; }
		int height() const { return m_height; }

		// Размещение тайлов последнего тика
		FCanvasInfo tiles() const;

		// Полный кадр камеры на ближайшем тике; пустой Mat — камеры нет
		void request_snapshot(const std::string& camera, FSnapshotSink sink);

		// Камеры видеопотока, которых нет в хранилище
		std::vector<std::string> missing_cameras() const;

	protected:
		void internal_handle_image(cv::Mat rgb_pixels) override {}

	private:
		void render_loop(int fps);

		struct FSnapshotRequest {
			std::string camera;
			FSnapshotSink sink;
		};

		struct FSourceWatch {
			std::shared_ptr<IFrame> last;
			std::chrono::steady_clock::time_point changed_at;
		};

	private:
		const int m_width;
		const int m_height;
		FCanvasSink m_sink;

		mutable std::mutex m_stream_mutex;
		FVideoStream m_stream;
		bool m_stream_dirty = true;

		mutable std::mutex m_tiles_mutex;
		FCanvasInfo m_tiles;

		std::mutex m_snapshot_mutex;
		std::deque<FSnapshotRequest> m_snapshots;
	};

} // namespace neural
} // namespace varan
