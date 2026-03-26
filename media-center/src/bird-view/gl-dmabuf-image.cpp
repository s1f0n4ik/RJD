#include "bird-view/gl-dmabuf-image.h"
#include "bird-view/gl-ext-loader.h"
#include "bird-view/utility.h"

#include <iostream>

namespace varan {
namespace birdview {

    bool UGLDmabufImage::try_create_from_dma_frame(
        EGLDisplay display,
        const FDmabufFrame& frame,
        EGLImageKHR& out_y,
        EGLImageKHR& out_uv,
        GLuint& out_tex_y,
        GLuint& out_tex_uv,
        ULogger* logger
    ) {
        // проверка инициализации указателей на функцию
        if (!g_gl.eglCreateImageKHR || !g_gl.glEGLImageTargetTexture2DOES) {
            logger->error("Cannot create texture from dmabuf: egl extenstions doesn't loaded");
            return false;
        }

        // Проверка fd
        if (frame.fds.size() != 1) {
            if (logger) logger->error("egl image create(): linux fd from fram doesn't request egl image requirements! Must be multy-plane fd (one fd for image)");
            return false;
        }

        // Создание изображений
        if (frame.format == "NV12" && frame.planes.size() == 2)
        {
            // формат NV12
            {
                // Плейн Y
                const auto& p = frame.planes[0];

                EGLint attrs[] = {
                    EGL_WIDTH, m_width,
                    EGL_HEIGHT, m_height,
                    EGL_LINUX_DRM_FOURCC_EXT, DRM_FORMAT_R8,

                    EGL_DMA_BUF_PLANE0_FD_EXT, frame.fds[0],
                    EGL_DMA_BUF_PLANE0_OFFSET_EXT, (EGLint)p.offset,
                    EGL_DMA_BUF_PLANE0_PITCH_EXT, (EGLint)p.stride,
                    EGL_NONE
                };

                out_y = g_gl.eglCreateImageKHR(display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, nullptr, attrs);
                EGLint err = eglGetError();

                if (out_y == EGL_NO_IMAGE_KHR) {
                    std::ostringstream oss;
                    oss << "egl image try_create_from_dma_frame(): cannot create egl image of uv plane from frame with fd=" << frame.fds[0]
                        << "; Error: " << eglErrorString(err) << " (0x" << std::hex << err << ")";
                    if (logger) logger->trace(oss.str());
                    return false;
                }

                glGenTextures(1, &out_tex_y);
                glBindTexture(GL_TEXTURE_2D, out_tex_y);
                g_gl.glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, out_y);
            }

            {
                // плейн UV
                const auto& p = frame.planes[1];

                EGLint attrs[] = {
                    EGL_WIDTH, m_width / 2,
                    EGL_HEIGHT, m_height / 2,
                    EGL_LINUX_DRM_FOURCC_EXT, DRM_FORMAT_RG88,

                    EGL_DMA_BUF_PLANE0_FD_EXT, frame.fds[0],
                    EGL_DMA_BUF_PLANE0_OFFSET_EXT, (EGLint)p.offset,
                    EGL_DMA_BUF_PLANE0_PITCH_EXT, (EGLint)p.stride,
                    EGL_NONE
                };

                out_uv = g_gl.eglCreateImageKHR(display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, nullptr, attrs);
                EGLint err = eglGetError();

                if (out_uv == EGL_NO_IMAGE_KHR) {
                    std::ostringstream oss;
                    oss << "egl image try_create_from_dma_frame(): cannot create egl image of uv plane from frame with fd=" << frame.fds[0]
                        << "; Error: " << eglErrorString(err) << " (0x" << std::hex << err << ")";
                    if (logger) logger->trace(oss.str());
                    return false;
                }

                glGenTextures(1, &out_tex_uv);
                glBindTexture(GL_TEXTURE_2D, out_tex_uv);
                g_gl.glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, out_uv);
            }

            return true;
        }
        else {
            if (logger) logger->error("egl image try_create_from_dma_frame(): unsupported dma format frame <" + frame.format + ">, cannot create egl image");
        }

        return false;
    }

	bool UGLDmabufImage::create(EGLDisplay display, std::optional<FDmabufFrame>&& frame, ULogger* logger) {
        if (!frame.has_value()) {
            if (logger) logger->trace("egl image create(): dma frame is null");
            if (m_dma_frame.has_value()) {
                logger->trace("egl image create(): using prevoius frame");
            }
            else {
                logger->trace("egl image create(): create fallback");
                create_fallback();
                m_dma_frame.reset();
            }
            return false;
        }

        EGLImageKHR new_image_y = EGL_NO_IMAGE_KHR;
        EGLImageKHR new_image_uv = EGL_NO_IMAGE_KHR;
        GLuint new_tex_y = 0;
        GLuint new_tex_uv = 0;

        // Попытка создать dma frame
        if (try_create_from_dma_frame(display, frame.value(),
            new_image_y, new_image_uv,
            new_tex_y, new_tex_uv,
            logger)
            )
        {
            // Если успешно - обновляем изображение, старое стираем
            destroy(display);

            m_image_y = new_image_y;
            m_image_uv = new_image_uv;
            m_texture_y = new_tex_y;
            m_texture_uv = new_tex_uv;

            m_dma_frame = std::move(frame.value());

            return true;
        }

        if (logger) logger->warn("egl image create(): failed, trying reuse previous frame");

        // Ели есть dma frame с свалидным значением
        if (m_dma_frame.has_value()) {
            return true;
        }

        // Если нет - создаем fallback
        if (logger) logger->warn("egl image create(): no valid frame, using fallback");

        create_fallback();
        m_dma_frame.reset();

        return false;
	}

    bool UGLDmabufImage::create_fallback() {
        // Освобождаем старые ресурсы (без EGLImage)
        if (m_texture_y) {
            glDeleteTextures(1, &m_texture_y);
            m_texture_y = 0;
        }

        if (m_texture_uv) {
            glDeleteTextures(1, &m_texture_uv);
            m_texture_uv = 0;
        }

        // Размер 1x1
        m_width = 1;
        m_height = 1;

        // ===== Y (R8) =====
        {
            uint8_t y = 128; // 0.5

            glGenTextures(1, &m_texture_y);
            glBindTexture(GL_TEXTURE_2D, m_texture_y);

            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

            glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, 1, 1, 0, GL_RED, GL_UNSIGNED_BYTE, &y);
        }

        // ===== UV (RG8) =====
        {
            uint8_t uv[2] = { 128, 128 }; // U=0.5, V=0.5

            glGenTextures(1, &m_texture_uv);
            glBindTexture(GL_TEXTURE_2D, m_texture_uv);

            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

            glTexImage2D(GL_TEXTURE_2D, 0, GL_RG8, 1, 1, 0, GL_RG, GL_UNSIGNED_BYTE, uv);
        }

        return true;
    }

    void UGLDmabufImage::bind(int unitY, int unitUV) {
        glActiveTexture(GL_TEXTURE0 + unitY);
        glBindTexture(GL_TEXTURE_2D, m_texture_y);

        glActiveTexture(GL_TEXTURE0 + unitUV);
        glBindTexture(GL_TEXTURE_2D, m_texture_uv);
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

        if (g_gl.eglDestroyImageKHR) {
            if (m_image_y != EGL_NO_IMAGE_KHR) {
                g_gl.eglDestroyImageKHR(display, m_image_y);
                m_image_y = EGL_NO_IMAGE_KHR;
            }

            if (m_image_uv != EGL_NO_IMAGE_KHR) {
                g_gl.eglDestroyImageKHR(display, m_image_uv);
                m_image_uv = EGL_NO_IMAGE_KHR;
            }
        }

        
    }

} // birdview
} // varan