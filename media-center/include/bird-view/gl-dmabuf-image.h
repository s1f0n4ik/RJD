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

        int width() const { return m_width; }
        int height() const { return m_height; }

        bool create(EGLDisplay display, std::optional<FDmabufFrame>&& frame, ULogger* logger);

        void bind(int unitY = 0, int unitUV = 1);

        void destroy(EGLDisplay display);

    private:
        GLuint m_texture_y = 0;
        GLuint m_texture_uv = 0;

        EGLImageKHR m_image_y = EGL_NO_IMAGE_KHR;
        EGLImageKHR m_image_uv = EGL_NO_IMAGE_KHR;

        int m_width = 0;
        int m_height = 0;

        std::optional<FDmabufFrame> m_dma_frame{std::nullopt};

        bool try_create_from_dma_frame(
            EGLDisplay display,
            const FDmabufFrame& frame,
            EGLImageKHR& out_y,
            EGLImageKHR& out_uv,
            GLuint& out_tex_y,
            GLuint& out_tex_u,
            ULogger* logger
        );

        bool create_fallback();
    };

} // birdview
} // varan