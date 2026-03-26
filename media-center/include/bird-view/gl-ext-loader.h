#pragma once

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2ext.h>

namespace varan {
namespace birdview {

    static bool has_ext(const char* list, const char* ext)
    {
        return list && strstr(list, ext);
    }

    struct FGLExtension
    {
        // EGL
        PFNEGLCREATEIMAGEKHRPROC eglCreateImageKHR = nullptr;
        PFNEGLDESTROYIMAGEKHRPROC eglDestroyImageKHR = nullptr;

        // GL
        PFNGLEGLIMAGETARGETTEXTURE2DOESPROC glEGLImageTargetTexture2DOES = nullptr;

        bool initialized = false;

        bool init(EGLDisplay display) {
            if (initialized)
                return true;

            if (!check_extensions(display)) {
                std::cerr << "Required extensions are missing\n";
                return false;
            }

            eglCreateImageKHR = (PFNEGLCREATEIMAGEKHRPROC)
                eglGetProcAddress("eglCreateImageKHR");

            eglDestroyImageKHR = (PFNEGLDESTROYIMAGEKHRPROC)
                eglGetProcAddress("eglDestroyImageKHR");

            glEGLImageTargetTexture2DOES = (PFNGLEGLIMAGETARGETTEXTURE2DOESPROC)
                eglGetProcAddress("glEGLImageTargetTexture2DOES");

            if (!eglCreateImageKHR || !eglDestroyImageKHR || !glEGLImageTargetTexture2DOES) {
                std::cerr << "Failed to load required EGL/GL functions\n";
                return false;
            }

            initialized = true;
            return true;
        }

        bool check_extensions(EGLDisplay display) {
            const char* egl_ext = eglQueryString(display, EGL_EXTENSIONS);
            if (!egl_ext) {
                std::cerr << "Failed to query EGL extensions\n";
                return false;
            }

            if (!has_ext(egl_ext, "EGL_KHR_image")) {
                std::cerr << "Missing EGL_KHR_image\n";
                return false;
            }

            if (!has_ext(egl_ext, "EGL_EXT_image_dma_buf_import")) {
                std::cerr << "Missing EGL_EXT_image_dma_buf_import\n";
                return false;
            }

            const char* gl_ext = (const char*)glGetString(GL_EXTENSIONS);
            if (!gl_ext) {
                std::cerr << "Failed to query GL extensions\n";
                return false;
            }

            if (!has_ext(gl_ext, "GL_OES_EGL_image")) {
                std::cerr << "Missing GL_OES_EGL_image\n";
                return false;
            }

            return true;
        }
    };


    // глобальный доступ
    inline  FGLExtension g_gl;

} // birdview
} // varan