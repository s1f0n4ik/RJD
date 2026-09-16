#include "bird-view/dmabuf-ring.h"
#include "bird-view/gl-ext-loader.h"
#include "bird-view/utility.h"

#include <drm/drm_fourcc.h>
#include <linux/dma-heap.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <sstream>

namespace varan {
namespace birdview {

	namespace {
		// CPU к буферам не обращается, некэшируемая куча снимает обслуживание кэша
		const char* const DMA_HEAPS[] = {
			"/dev/dma_heap/system-uncached",
			"/dev/dma_heap/system",
		};

		int alloc_dmabuf(size_t size, ULogger* logger) {
			for (const char* path : DMA_HEAPS) {
				const int heap = open(path, O_RDONLY | O_CLOEXEC);
				if (heap < 0) continue;

				dma_heap_allocation_data req{};
				req.len = size;
				req.fd_flags = O_RDWR | O_CLOEXEC;
				const int rc = ioctl(heap, DMA_HEAP_IOCTL_ALLOC, &req);
				const int err = errno;
				close(heap);
				if (rc == 0) return static_cast<int>(req.fd);
				if (logger) logger->warn(std::string("alloc_dmabuf(): ") + path
					+ " failed: " + strerror(err));
			}
			return -1;
		}
	}

	bool UDmabufRing::init(UEGLContextManager* context, int width, int height, int depth, ULogger* logger) {
		destroy();
		m_context = context;
		m_logger = logger;
		m_width = width;
		m_height = height;
		m_stride = width * 4;
		m_size = static_cast<size_t>(m_stride) * height;

		if (!context || !g_gl.eglCreateImageKHR || !g_gl.glEGLImageTargetTexture2DOES) {
			if (logger) logger->error("UDmabufRing::init(): EGL image functions are not loaded");
			return false;
		}

		glGenRenderbuffers(1, &m_depth);
		glBindRenderbuffer(GL_RENDERBUFFER, m_depth);
		glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT16, width, height);

		m_busy = std::make_shared<FBusy>(static_cast<size_t>(depth));

		for (int i = 0; i < depth; ++i) {
			FSlot s;
			s.fd = alloc_dmabuf(m_size, logger);
			if (s.fd < 0) {
				if (logger) logger->error("UDmabufRing::init(): dma-heap allocation failed");
				destroy();
				return false;
			}
			m_slots.push_back(s);
			FSlot& slot = m_slots.back();

			// Байты R,G,B,A в памяти: DRM ABGR8888 и есть RGBA у GL и GStreamer
			const EGLint attrs[] = {
				EGL_WIDTH, width,
				EGL_HEIGHT, height,
				EGL_LINUX_DRM_FOURCC_EXT, DRM_FORMAT_ABGR8888,
				EGL_DMA_BUF_PLANE0_FD_EXT, slot.fd,
				EGL_DMA_BUF_PLANE0_OFFSET_EXT, 0,
				EGL_DMA_BUF_PLANE0_PITCH_EXT, m_stride,
				EGL_NONE
			};
			slot.image = g_gl.eglCreateImageKHR(context->get_display(), EGL_NO_CONTEXT,
				EGL_LINUX_DMA_BUF_EXT, nullptr, attrs);
			if (slot.image == EGL_NO_IMAGE_KHR) {
				const EGLint err = eglGetError();
				if (logger) {
					std::ostringstream oss;
					oss << "UDmabufRing::init(): eglCreateImageKHR failed: " << eglErrorString(err)
						<< " (0x" << std::hex << err << ")";
					logger->error(oss.str());
				}
				destroy();
				return false;
			}

			glGenTextures(1, &slot.texture);
			glBindTexture(GL_TEXTURE_2D, slot.texture);
			glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
			glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
			glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
			glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
			g_gl.glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, slot.image);

			glGenFramebuffers(1, &slot.fbo);
			glBindFramebuffer(GL_FRAMEBUFFER, slot.fbo);
			glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, slot.texture, 0);
			glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, m_depth);

			const GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
			if (status != GL_FRAMEBUFFER_COMPLETE) {
				if (logger) logger->error("UDmabufRing::init(): FBO on dma-buf is not complete, status=0x"
					+ [status] { std::ostringstream o; o << std::hex << status; return o.str(); }());
				glBindFramebuffer(GL_FRAMEBUFFER, 0);
				destroy();
				return false;
			}
		}
		glBindFramebuffer(GL_FRAMEBUFFER, 0);

		if (logger) logger->info("UDmabufRing::init(): " + std::to_string(depth) + " x "
			+ std::to_string(width) + "x" + std::to_string(height) + " RGBA on dma-heap, stride="
			+ std::to_string(m_stride));
		return true;
	}

	void UDmabufRing::destroy() {
		for (auto& s : m_slots) {
			if (s.fence) glDeleteSync(s.fence);
			if (s.fbo) glDeleteFramebuffers(1, &s.fbo);
			if (s.texture) glDeleteTextures(1, &s.texture);
			if (s.image != EGL_NO_IMAGE_KHR && m_context && g_gl.eglDestroyImageKHR) {
				g_gl.eglDestroyImageKHR(m_context->get_display(), s.image);
			}
			if (s.fd >= 0) close(s.fd);
		}
		m_slots.clear();
		if (m_depth) {
			glDeleteRenderbuffers(1, &m_depth);
			m_depth = 0;
		}
		m_busy.reset();
		m_next = 0;
	}

	int UDmabufRing::acquire() {
		const size_t n = m_slots.size();
		for (size_t k = 0; k < n; ++k) {
			const size_t i = (m_next + k) % n;
			if (m_slots[i].fence || m_busy->flags[i].load()) continue;
			m_next = (i + 1) % n;
			return static_cast<int>(i);
		}
		return -1;
	}

	UEGLContextManager::FRenderTarget UDmabufRing::target(int slot) const {
		UEGLContextManager::FRenderTarget t;
		t.fbo = m_slots[slot].fbo;
		t.texture = m_slots[slot].texture;
		t.depth = m_depth;
		t.width = m_width;
		t.height = m_height;
		return t;
	}

	void UDmabufRing::mark_rendered(int slot) {
		FSlot& s = m_slots[slot];
		if (s.fence) glDeleteSync(s.fence);
		s.fence = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
	}

	bool UDmabufRing::wait_ready(int slot, GLuint64 timeout_ns) {
		FSlot& s = m_slots[slot];
		if (!s.fence) return false;
		const GLenum st = glClientWaitSync(s.fence, GL_SYNC_FLUSH_COMMANDS_BIT, timeout_ns);
		glDeleteSync(s.fence);
		s.fence = nullptr;
		return st == GL_ALREADY_SIGNALED || st == GL_CONDITION_SATISFIED;
	}

	std::function<void()> UDmabufRing::hand_over(int slot) {
		auto busy = m_busy;
		busy->flags[slot].store(true);
		return [busy, slot] { busy->flags[slot].store(false); };
	}

} // birdview
} // varan
