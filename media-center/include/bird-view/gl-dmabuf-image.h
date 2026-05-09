#pragma once

#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <drm/drm_fourcc.h>

#include <optional>

#include <vector>
#include <unistd.h>
#include <cstring>

#include "utility/dma-frame.h"
#include "logger.h"

namespace varan {
namespace birdview {

    class UGLDmabufImage
    {
    public:
        GLuint texture_y() const { return m_texture_y; }
        GLuint texture_uv() const { return m_texture_uv; }

        EGLImageKHR image_y() const { return m_image_y; }
        EGLImageKHR image_uv() const { return m_image_uv; }

        GLuint texture_nv12() const { return m_texture_nv12; }
        EGLImageKHR image_nv12() const{ return m_image_nv12; }

        int width() const { return m_width; }
        int height() const { return m_height; }

        bool has_texture() const;

        bool create(EGLDisplay display, std::optional<FDmabufFrame>&& frame, ULogger* logger);

        void bind(int unit = 0);

        void destroy(EGLDisplay display);

        static EGLImageKHR fallback_image();
        static int fallback_fd();

    private:
        GLuint m_texture_y = 0;
        GLuint m_texture_uv = 0;

        EGLImageKHR m_image_y = EGL_NO_IMAGE_KHR;
        EGLImageKHR m_image_uv = EGL_NO_IMAGE_KHR;

        GLuint m_texture_nv12 = 0;
        EGLImageKHR m_image_nv12 = EGL_NO_IMAGE_KHR;

        int m_width = 0;
        int m_height = 0;

        std::optional<FDmabufFrame> m_dma_frame{std::nullopt};

        static EGLImageKHR s_fallback_image;
        static int s_fallback_fd;
        static bool s_fallback_initialized;

        bool try_create_from_dma_frame(
            EGLDisplay display,
            const FDmabufFrame& frame,
            EGLImageKHR& out_nv12,
            GLuint& out_texture_nv12,
            ULogger* logger
        );

        bool create_fallback(EGLDisplay display, ULogger* logger);

        static bool init_fallback(EGLDisplay display, ULogger* logger);
    };

} // birdview
} // varan