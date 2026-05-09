#pragma once

#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#include <EGL/egl.h>
#include <EGL/eglext.h>

#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>

#include "logger.h"

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

            bool init(EGLDisplay display, ULogger* logger = nullptr)
            {
                if (initialized) {
                    return true;
                }

                if (!check_extensions(display, logger)) {
                    if (logger) logger->error("FGLExtension: Required extensions are missing");
                    return false;
                }

                eglCreateImageKHR = (PFNEGLCREATEIMAGEKHRPROC)eglGetProcAddress("eglCreateImageKHR");
                eglDestroyImageKHR = (PFNEGLDESTROYIMAGEKHRPROC)eglGetProcAddress("eglDestroyImageKHR");
                glEGLImageTargetTexture2DOES = (PFNGLEGLIMAGETARGETTEXTURE2DOESPROC)eglGetProcAddress("glEGLImageTargetTexture2DOES");

                if (!eglCreateImageKHR || !eglDestroyImageKHR || !glEGLImageTargetTexture2DOES) {
                    if (logger) logger->error("FGLExtension: Failed to load required EGL/GL functions");
                    return false;
                }

                initialized = true;
                return true;
            }

            bool check_extensions(EGLDisplay display, ULogger* logger = nullptr)
            {
                if (display == EGL_NO_DISPLAY) {
                    if (logger) logger->error("check_extensions(): EGL_NO_DISPLAY");
                    return false;
                }

                const char* egl_ext = eglQueryString(display, EGL_EXTENSIONS);
                if (!egl_ext) {
                    if (logger) logger->error("check_extensions(): Failed to query EGL extensions");
                    return false;
                }

                if (!has_ext(egl_ext, "EGL_KHR_image")) {
                    if (logger) logger->error("check_extensions(): Missing EGL_KHR_image");
                    return false;
                }

                if (!has_ext(egl_ext, "EGL_EXT_image_dma_buf_import")) {
                    if (logger) logger->error("check_extensions(): Missing EGL_EXT_image_dma_buf_import");
                    return false;
                }

                std::string gl_all;

                // Так же ищем расширения в обычном GL 
                GLint n = 0;
                glGetIntegerv(GL_NUM_EXTENSIONS, &n);

                if (n > 0) {
                    for (GLint i = 0; i < n; i++) {
                        const char* ext = (const char*)glGetStringi(GL_EXTENSIONS, i);
                        if (ext) {
                            gl_all += ext;
                            gl_all += " ";
                        }
                    }
                }
                else {
                    const char* gl_ext = (const char*)glGetString(GL_EXTENSIONS);
                    if (!gl_ext) {
                        if (logger) logger->error("check_extensions(): Failed to query GL extensions at unified path");
                        return false;
                    }
                    gl_all = gl_ext;
                }

                if (!has_ext(gl_all.c_str(), "GL_OES_EGL_image")) {
                    if (logger) logger->error("check_extensions(): Missing GL_OES_EGL_image");
                    return false;
                }

                if (logger) logger->info("check_extensions(): OK");
                return true;
            }
        };

        inline FGLExtension g_gl;

    } // birdview
} // varan