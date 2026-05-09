#include <fcntl.h>
#include <gbm.h>
#include <sys/mman.h>
#include <unistd.h>
#include <iostream>

#include "bird-view/gl-dmabuf-image.h"
#include "bird-view/gl-ext-loader.h"
#include "bird-view/utility.h"

namespace varan {
namespace birdview {

    // Иницализация переменных статик
    EGLImageKHR UGLDmabufImage::s_fallback_image = EGL_NO_IMAGE_KHR;
    int UGLDmabufImage::s_fallback_fd = -1;
    bool UGLDmabufImage::s_fallback_initialized = false;

    bool UGLDmabufImage::try_create_from_dma_frame(
        EGLDisplay display,
        const FDmabufFrame& frame,
        EGLImageKHR& out_nv12,
        GLuint& out_texture_nv12,
        ULogger* logger
    ) {
        // проверка инициализации указателей на функцию
        if (!g_gl.eglCreateImageKHR || !g_gl.glEGLImageTargetTexture2DOES) {
            logger->error("Cannot create texture from dmabuf: egl extenstions doesn't loaded");
            return false;
        }

        // Проверка fd
        if (!(frame.fds.size() == 1 || frame.fds.size() == frame.planes.size())) {
            if (logger) logger->error("egl image create(): linux fd from fram doesn't request egl image requirements!");
            return false;
        }

        auto get_fd = [&](size_t planeIndex) -> int {
            if (frame.fds.size() == 1) return frame.fds[0];
            return frame.fds[planeIndex];
        };

        // Создание изображений
        if (frame.format == "NV12" && frame.planes.size() == 2)
        {
            // формат NV12
            const auto& y = frame.planes[0];
            const auto& uv = frame.planes[1];

            EGLint attrs[] = {
                EGL_WIDTH, (EGLint)frame.width,
                EGL_HEIGHT, (EGLint)frame.height,
                EGL_LINUX_DRM_FOURCC_EXT, DRM_FORMAT_NV12,

                EGL_DMA_BUF_PLANE0_FD_EXT, get_fd(0),
                EGL_DMA_BUF_PLANE0_OFFSET_EXT, (EGLint)y.offset,
                EGL_DMA_BUF_PLANE0_PITCH_EXT, (EGLint)y.stride,

                EGL_DMA_BUF_PLANE1_FD_EXT, get_fd(0),
                EGL_DMA_BUF_PLANE1_OFFSET_EXT, (EGLint)uv.offset,
                EGL_DMA_BUF_PLANE1_PITCH_EXT, (EGLint)uv.stride,

                EGL_NONE
            };

            out_nv12 = g_gl.eglCreateImageKHR(display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, nullptr, attrs);
            EGLint err = eglGetError();


            if (out_nv12 == EGL_NO_IMAGE_KHR) {
                std::ostringstream oss;
                oss << "egl image try_create_from_dma_frame(): cannot create egl image of y plane from frame with fd=" << get_fd(0)
                    << "; Error: " << eglErrorString(err) << " (0x" << std::hex << err << ")";
                if (logger) logger->trace(oss.str());
                return false;
            }
            else {
                if (logger) logger->trace("egl image try_create_from_dma_frame(): successfully created egl multiplaned image from frame fd=" + std::to_string(get_fd(0)));
            }

            glGenTextures(1, &out_texture_nv12);
            glBindTexture(GL_TEXTURE_EXTERNAL_OES, out_texture_nv12);

            glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

            g_gl.glEGLImageTargetTexture2DOES(GL_TEXTURE_EXTERNAL_OES, out_nv12);

            return true;
        } else {
            if (logger) logger->trace("egl image try_create_from_dma_frame(): not supported dma frame format <" + frame.format + "> for creation egl image");
        }

        return false;
    }

    bool UGLDmabufImage::has_texture() const {
        return (m_dma_frame.has_value() && m_texture_nv12 && m_image_nv12 != EGL_NO_IMAGE_KHR) ? true : false;
    }

	bool UGLDmabufImage::create(EGLDisplay display, std::optional<FDmabufFrame>&& frame, ULogger* logger) {
        if (!frame.has_value()) {
            if (logger) logger->trace("egl image create(): dma frame is null");
            if (m_dma_frame.has_value()) {
                logger->trace("egl image create(): using prevoius frame");
            }
            return false;
        }

        EGLImageKHR new_image_nv12 = EGL_NO_IMAGE_KHR;
        GLuint new_tex_nv12 = 0;

        // Попытка создать dma frame
        if (try_create_from_dma_frame(display, frame.value(), new_image_nv12, new_tex_nv12, logger)) {
            // Если успешно - обновляем изображение, старое стираем
            destroy(display);

            m_image_nv12 = new_image_nv12;
            m_texture_nv12 = new_tex_nv12;

            m_dma_frame = std::move(frame.value());

            return true;
        }

        if (logger) logger->warn("egl image create(): failed, trying reuse previous frame");

        // Ели есть dma frame с валидным значением
        if (m_dma_frame.has_value()) {
            return false;
        }

        return false;
	}

    bool UGLDmabufImage::create_fallback(EGLDisplay display, ULogger* logger) {
        // Освобождаем старые ресурсы (без EGLImage)
        if (!s_fallback_initialized) {
            if (!init_fallback(display, logger)) {
                return false;
            }
        }

        if (m_texture_nv12) {
            glDeleteTextures(1, &m_texture_nv12);
            m_texture_nv12 = 0;
        }

        glGenTextures(1, &m_texture_nv12);
        glBindTexture(GL_TEXTURE_EXTERNAL_OES, m_texture_nv12);
        g_gl.glEGLImageTargetTexture2DOES(GL_TEXTURE_EXTERNAL_OES, s_fallback_image);

        return true;
    }

    void UGLDmabufImage::bind(int unit) {
        glActiveTexture(GL_TEXTURE0 + unit);
        glBindTexture(GL_TEXTURE_EXTERNAL_OES, m_texture_nv12);
    }

    void UGLDmabufImage::destroy(EGLDisplay display) {
        if (m_texture_y) {
            glDeleteTextures(1, &m_texture_y);
            m_texture_y = 0;
        }

        if (m_texture_uv) {
            glDeleteTextures(1, &m_texture_uv);
            m_texture_uv = 0;
        }

        if (m_texture_nv12) {
            glDeleteTextures(1, &m_texture_nv12);
            m_texture_nv12 = 0;
        }

        if (g_gl.eglDestroyImageKHR) {
            if (m_image_y != EGL_NO_IMAGE_KHR) {
                g_gl.eglDestroyImageKHR(display, m_image_y);
                m_image_y = EGL_NO_IMAGE_KHR;
            }

            if (m_image_uv != EGL_NO_IMAGE_KHR) {
                g_gl.eglDestroyImageKHR(display, m_image_uv);
                m_image_uv = EGL_NO_IMAGE_KHR;
            }

            if (m_image_nv12 != EGL_NO_IMAGE_KHR) {
                g_gl.eglDestroyImageKHR(display, m_image_nv12);
                m_image_nv12 = EGL_NO_IMAGE_KHR;
            }
        }

        m_dma_frame.reset();
    }

    bool UGLDmabufImage::init_fallback(EGLDisplay display, ULogger* logger) {
        if (s_fallback_initialized) {
            return true;
        }

        if (!g_gl.eglCreateImageKHR || !g_gl.glEGLImageTargetTexture2DOES) {
            logger->error("egl image init_fallback(): Cannot create texture from dmabuf: egl extenstions doesn't loaded");
            return false;
        }

        // Создаём небольшой буфер NV12 32x32
        const int width = 128;
        const int height = 128;
        const size_t y_size = width * height;
        const size_t uv_size = width * height / 2; // NV12 UV plane
        const size_t total_size = y_size + uv_size;

        /*
        // Открываем анонимный memfd (Linux) для dma-buf
        s_fallback_fd = memfd_create("fallback_nv12", MFD_CLOEXEC | MFD_ALLOW_SEALING);
        if (s_fallback_fd < 0) {
            if (logger) logger->error("egl image init_fallback(): Cannot create memfd for fallback");
            return false;
        }

        if (ftruncate(s_fallback_fd, total_size) != 0) {
            if (logger) logger->error("egl image init_fallback(): Cannot set size for fallback memfd");
            close(s_fallback_fd);
            s_fallback_fd = -1;
            return false;
        }

        // Мэпим и заполняем серым (Y=128, UV=128)
        uint8_t* ptr = (uint8_t*)mmap(nullptr, total_size, PROT_READ | PROT_WRITE, MAP_SHARED, s_fallback_fd, 0);

        if (ptr == MAP_FAILED) {
            if (logger) logger->error("egl image init_fallback(): mmap failed");
            close(s_fallback_fd);
            s_fallback_fd = -1;
            return false;
        }

        // Y plane
        memset(ptr, 128, y_size);
        // UV plane
        memset(ptr + y_size, 128, uv_size);

        munmap(ptr, total_size);
        */

        int fd_drm = open("/dev/dri/renderD128", O_RDWR);
        if (fd_drm < 0) {
            if (logger) logger->trace("egl image init_fallback(): cannot open drm /dev/dri/renderD128");
            return false;
        }

        gbm_device* gbm = gbm_create_device(fd_drm);
        if (!gbm) {
            close(fd_drm);
        }

        gbm_bo* bo = gbm_bo_create(gbm, width, height, GBM_FORMAT_ARGB8888, GBM_BO_USE_LINEAR);

        if (!bo) {
            if (logger) logger->trace("egl image init_fallback(): gbm_bo_create failed");
            gbm_device_destroy(gbm);
            close(fd_drm);
            return false;
        }

        s_fallback_fd = gbm_bo_get_fd(bo);

        gbm_bo_destroy(bo);
        gbm_device_destroy(gbm);
        close(fd_drm);

        // Создаём EGLImageKHR
        EGLint attrs[] = {
            EGL_WIDTH, width,
            EGL_HEIGHT, height,
            EGL_LINUX_DRM_FOURCC_EXT, DRM_FORMAT_NV12,
            EGL_DMA_BUF_PLANE0_FD_EXT, s_fallback_fd,
            EGL_DMA_BUF_PLANE0_OFFSET_EXT, 0,
            EGL_DMA_BUF_PLANE0_PITCH_EXT, width,
            EGL_DMA_BUF_PLANE1_FD_EXT, s_fallback_fd,
            EGL_DMA_BUF_PLANE1_OFFSET_EXT, (EGLint)y_size,
            EGL_DMA_BUF_PLANE1_PITCH_EXT, width,
            EGL_NONE
        };

        s_fallback_image = g_gl.eglCreateImageKHR(display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, nullptr, attrs);
        EGLint err = eglGetError();
        if (s_fallback_image == EGL_NO_IMAGE_KHR) {
            if (logger) {
                std::ostringstream oss;
                oss << "Failed to create fallback EGLImageKHR: " << eglErrorString(err) << " (0x" << std::hex << err << ")";
                logger->error(oss.str());
            }
            close(s_fallback_fd);
            s_fallback_fd = -1;
            return false;
        }

        if (logger) logger->debug("Fallback NV12 EGLImageKHR created successfully");
        s_fallback_initialized = true;

        return true;
    }

} // birdview
} // varan