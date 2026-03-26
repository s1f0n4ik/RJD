#pragma once
#include <EGL/egl.h>
#include "gl-ext-loader.h"

#include "logger.h"

namespace varan {
namespace birdview {

    struct FEGLContext
    {
        EGLDisplay display = EGL_NO_DISPLAY;
        EGLContext context = EGL_NO_CONTEXT;
        EGLSurface surface = EGL_NO_SURFACE;

        bool init(ULogger* logger = nullptr) {
            // выбор лисплея
            display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
            if (display == EGL_NO_DISPLAY) {
                if (logger) logger->error("eglGetDisplay failed");
                return false;
            }

            // иниаицлизация EGL 
            if (!eglInitialize(display, nullptr, nullptr)) {
                if (logger) logger->error("eglInitialize failed");
                return false;
            }

            // 3. Config
            const EGLint config_attribs[] = {
                EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
                EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
                EGL_RED_SIZE, 8,
                EGL_GREEN_SIZE, 8,
                EGL_BLUE_SIZE, 8,
                EGL_NONE
            };

            EGLConfig config;
            EGLint num_configs = 0;

            if (!eglChooseConfig(display, config_attribs, &config, 1, &num_configs) || num_configs == 0) {
                if (logger) logger->error("eglChooseConfig failed");
                return false;
            }

            // миниальный буфер
            const EGLint pbuffer_attribs[] = {
                EGL_WIDTH, 1,
                EGL_HEIGHT, 1,
                EGL_NONE
            };

            surface = eglCreatePbufferSurface(display, config, pbuffer_attribs);
            if (surface == EGL_NO_SURFACE) {
                if (logger) logger->error("eglCreatePbufferSurface failed");
                return false;
            }

            // контекст EGL
            const EGLint context_attribs[] = {
                EGL_CONTEXT_CLIENT_VERSION, 2,
                EGL_NONE
            };

            context = eglCreateContext(display, config, EGL_NO_CONTEXT, context_attribs);
            if (context == EGL_NO_CONTEXT) {
                if (logger) logger->error("eglCreateContext failed");
                return false;
            }

            if (!eglMakeCurrent(display, surface, surface, context)) {
                if (logger) logger->error("eglMakeCurrent failed");
                return false;
            }

            // Инициализация loader
            if (!g_gl.init(display)) {
                if (logger) logger->error("GL extensions init failed");
                return false;
            }

            return true;
        }

        void destroy() {
            if (display != EGL_NO_DISPLAY) {

                eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);

                if (context != EGL_NO_CONTEXT) {
                    eglDestroyContext(display, context);
                    context = EGL_NO_CONTEXT;
                }

                if (surface != EGL_NO_SURFACE) {
                    eglDestroySurface(display, surface);
                    surface = EGL_NO_SURFACE;
                }

                eglTerminate(display);
                display = EGL_NO_DISPLAY;
            }
        }
    };

} // varan
} // birdview
