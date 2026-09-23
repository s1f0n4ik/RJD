#include "neural/canvas-composer.h"

#include <map>
#include <thread>

namespace varan {
namespace neural {

	namespace {
		// Кадр камеры не менялся дольше этого — тайл считается замёрзшим и не рисуется
		constexpr auto TILE_STALL_TIMEOUT = std::chrono::seconds(3);
		constexpr float GREY = 114.f / 255.f;
	}

	UCanvasComposer::UCanvasComposer(
		birdview::UEGLContextManager* context,
		FFrameStorage<IFrame>* storage,
		int width,
		int height,
		const FVideoStream& stream,
		FCanvasSink sink,
		ULogger::ELoggerLevel level,
		const std::string& name)
		: UImageHandler(context, storage, level, name)
		, m_width(width)
		, m_height(height)
		, m_sink(std::move(sink))
		, m_stream(stream)
	{
	}

	UCanvasComposer::~UCanvasComposer() {
		stop();
	}

	bool UCanvasComposer::start(int fps) {
		if (m_running_thread || m_handler_thread.joinable()) return true;
		if (!m_initialized_context) {
			m_logger.error("start(): shared GL context is not initialized");
			return false;
		}
		m_running_thread = true;
		m_handler_thread = std::thread(&UCanvasComposer::render_loop, this, std::max(1, fps));
		return true;
	}

	void UCanvasComposer::stop() {
		if (m_handler_thread.joinable()) stop_handler_thread();
	}

	void UCanvasComposer::set_stream(const FVideoStream& stream) {
		std::lock_guard<std::mutex> lk(m_stream_mutex);
		m_stream = stream;
		m_stream_dirty = true;
	}

	FVideoStream UCanvasComposer::stream() const {
		std::lock_guard<std::mutex> lk(m_stream_mutex);
		return m_stream;
	}

	FCanvasInfo UCanvasComposer::tiles() const {
		std::lock_guard<std::mutex> lk(m_tiles_mutex);
		return m_tiles;
	}

	void UCanvasComposer::request_snapshot(const std::string& camera, FSnapshotSink sink) {
		std::lock_guard<std::mutex> lk(m_snapshot_mutex);
		m_snapshots.push_back({ camera, std::move(sink) });
	}

	std::vector<std::string> UCanvasComposer::missing_cameras() const {
		std::vector<std::string> out;
		for (const auto& cam : stream_cameras(stream()))
			if (!m_storage || !m_storage->is_exists(cam)) out.push_back(cam);
		return out;
	}

	void UCanvasComposer::render_loop(int fps) {
		using clock = std::chrono::steady_clock;

		if (!eglMakeCurrent(m_context.display, m_context.surface, m_context.surface, m_context.context)) {
			m_logger.error("render_loop(): cannot make GL context current");
			m_running_thread = false;
			return;
		}

		UImageConverter render;
		UImageConverter snap;
		if (!render.init(&m_logger) || !snap.init(&m_logger)) {
			m_logger.error("render_loop(): converter didn't initialize");
			eglMakeCurrent(m_context.display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
			m_running_thread = false;
			return;
		}
		if (!render.create_fbo(m_width, m_height, &m_logger)) {
			m_logger.error("render_loop(): canvas framebuffer didn't create");
			eglMakeCurrent(m_context.display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
			m_running_thread = false;
			return;
		}
		int snap_w = 0;
		int snap_h = 0;

		const auto frame_time = std::chrono::microseconds(1000000 / fps);
		auto next_frame = clock::now() + frame_time;

		FVideoStream stream;
		std::vector<FTilePlacement> cells;
		std::vector<ETileFit> fits;
		std::map<std::string, FSourceWatch> watches;

		while (m_running_thread) {
			{
				std::lock_guard<std::mutex> lk(m_stream_mutex);
				if (m_stream_dirty) {
					stream = m_stream;
					cells = place_cells(stream);
					fits.clear();
					for (const auto& t : stream.tiles) fits.push_back(t.fit);
					m_stream_dirty = false;
				}
			}

			const auto now = clock::now();
			render.bind_fbo();
			glClearColor(GREY, GREY, GREY, 1.0f);
			glClear(GL_COLOR_BUFFER_BIT);

			auto placements = cells;
			for (size_t i = 0; i < placements.size(); ++i) {
				auto& p = placements[i];
				auto ptr = m_storage->extract(p.camera);
				auto frame = std::dynamic_pointer_cast<USharedGLTextureWrapper>(ptr);
				if (!frame) {
					p.state = ETileState::NO_CAMERA;
					watches.erase(p.camera);
					continue;
				}

				auto& w = watches[p.camera];
				if (w.last != ptr) {
					w.last = ptr;
					w.changed_at = now;
				}
				if (now - w.changed_at > TILE_STALL_TIMEOUT) {
					p.state = ETileState::STALLED;
					continue;
				}

				p.state = ETileState::OK;
				p.cam_w = static_cast<int>(frame->width);
				p.cam_h = static_cast<int>(frame->height);
				p.dst = fit_rect(p.cell, p.crop, p.cam_w, p.cam_h, fits[i]);
				glViewport(p.dst.x, p.dst.y, p.dst.width, p.dst.height);
				render.render(frame.get(), &m_logger, p.crop);
			}

			glViewport(0, 0, m_width, m_height);
			cv::Mat rgba(m_height, m_width, CV_8UC4);
			glReadPixels(0, 0, m_width, m_height, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data);

			auto info = std::make_shared<const std::vector<FTilePlacement>>(std::move(placements));
			{
				std::lock_guard<std::mutex> lk(m_tiles_mutex);
				m_tiles = info;
			}
			if (m_sink) m_sink(std::move(rgba), info);

			std::deque<FSnapshotRequest> requests;
			{
				std::lock_guard<std::mutex> lk(m_snapshot_mutex);
				requests.swap(m_snapshots);
			}
			for (auto& r : requests) {
				auto frame = std::dynamic_pointer_cast<USharedGLTextureWrapper>(m_storage->extract(r.camera));
				if (!frame) {
					if (r.sink) r.sink(cv::Mat());
					continue;
				}
				const int w = static_cast<int>(frame->width);
				const int h = static_cast<int>(frame->height);
				if (w != snap_w || h != snap_h) {
					snap.destroy_fbo();
					if (!snap.create_fbo(w, h, &m_logger)) {
						if (r.sink) r.sink(cv::Mat());
						continue;
					}
					snap_w = w;
					snap_h = h;
				}
				snap.bind_fbo();
				glClearColor(0.f, 0.f, 0.f, 1.f);
				glClear(GL_COLOR_BUFFER_BIT);
				snap.render(frame.get(), &m_logger);
				cv::Mat shot(h, w, CV_8UC4);
				glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, shot.data);
				if (r.sink) r.sink(std::move(shot));
			}

			const auto after = clock::now();
			if (next_frame < after) {
				next_frame = after + frame_time;
			}
			else {
				std::this_thread::sleep_until(next_frame);
				next_frame += frame_time;
			}
		}

		{
			std::lock_guard<std::mutex> lk(m_snapshot_mutex);
			for (auto& r : m_snapshots) if (r.sink) r.sink(cv::Mat());
			m_snapshots.clear();
		}
		snap.destroy_fbo();
		render.unbind_fbo();
		render.destroy_fbo();
		eglMakeCurrent(m_context.display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
		m_running_thread = false;
	}

} // namespace neural
} // namespace varan
