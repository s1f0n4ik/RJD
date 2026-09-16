#pragma once

#include <atomic>
#include <functional>
#include <memory>
#include <vector>

#include "bird-view/egl-context.h"
#include "logger.h"

namespace varan {
namespace birdview {

	/*
		Кольцо кадровых буферов на dma-buf: GPU рисует в них напрямую,
		кодек забирает кадр по дескриптору без копии через CPU.

		Слот занят, пока кодек держит буфер; флаг занятости живёт отдельно
		от кольца, чтобы колбэк освобождения из потока GStreamer пережил его.
	*/
	class UDmabufRing {
	public:
		~UDmabufRing() { destroy(); }

		bool init(UEGLContextManager* context, int width, int height, int depth, ULogger* logger);
		void destroy();

		bool valid() const { return !m_slots.empty(); }

		// Свободный слот или -1, когда все кадры ещё у GPU или кодека
		int acquire();

		UEGLContextManager::FRenderTarget target(int slot) const;

		// Конец рисования слота: fence, по которому ждётся готовность
		void mark_rendered(int slot);

		// Готовность кадра слота; false - GPU не успел за timeout_ns
		bool wait_ready(int slot, GLuint64 timeout_ns);

		// Передача кадра кодеку: слот занят до вызова возвращённого колбэка
		std::function<void()> hand_over(int slot);

		int fd(int slot) const { return m_slots[slot].fd; }
		size_t size() const { return m_size; }
		int stride() const { return m_stride; }

	private:
		struct FSlot {
			int fd = -1;
			EGLImageKHR image = EGL_NO_IMAGE_KHR;
			GLuint texture = 0;
			GLuint fbo = 0;
			GLsync fence = nullptr;
		};

		struct FBusy {
			std::vector<std::atomic<bool>> flags;
			explicit FBusy(size_t n) : flags(n) {}
		};

		UEGLContextManager* m_context = nullptr;
		std::vector<FSlot> m_slots;
		std::shared_ptr<FBusy> m_busy;
		GLuint m_depth = 0;
		int m_width = 0;
		int m_height = 0;
		int m_stride = 0;
		size_t m_size = 0;
		size_t m_next = 0;
		ULogger* m_logger = nullptr;
	};

} // birdview
} // varan
