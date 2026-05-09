#pragma once

#include <gbm.h>
#include <fcntl.h>
#include <unistd.h>

#include "gl-ext-loader.h"
#include "logger.h"

namespace varan {
namespace birdview {

    struct FEGLContext {
        EGLDisplay display = EGL_NO_DISPLAY;
        EGLContext context = EGL_NO_CONTEXT;
        EGLSurface surface = EGL_NO_SURFACE;
        EGLConfig config = nullptr;
    };

    class UEGLContextManager
    {
    private:
        FEGLContext m_main_context;

        GLuint m_fbo = 0;
        GLuint m_fbo_texture = 0;

        bool m_render_buffer_initialized{ false };
        bool m_is_initialzed{ false };

    public:
        EGLDisplay get_display() const { return m_main_context.display; }
        EGLContext get_context() const { return m_main_context.context; }
        EGLSurface get_surface() const { return m_main_context.surface; }
        EGLConfig  get_config() const { return m_main_context.config; }

        GLuint get_fbo() const { return m_fbo; }
        GLuint get_fbo_texture() const { return m_fbo_texture; }

        bool is_render_buffer_initialized() const { return m_render_buffer_initialized; }
        bool is_initialized() const { return m_is_initialzed; }

        bool init(bool use_surface = false, ULogger* logger = nullptr) {
            // выбор лисплея
            /*
            int fd = open("/dev/dri/renderD128", O_RDWR);
            if (fd < 0) {
                logger->error("Failed to open DRM device");
                return false;
            }

            gbm_device* gbm = gbm_create_device(fd);

            m_main_context.display = eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, gbm, nullptr);
            */
            m_main_context.display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
            if (m_main_context.display == EGL_NO_DISPLAY) {
                if (logger) logger->error("eglGetDisplay failed");
                return false;
            }

            // иниаицлизация EGL 
            if (!eglInitialize(m_main_context.display, nullptr, nullptr)) {
                if (logger) logger->error("eglInitialize failed");
                return false;
            }

            // 3. Config
            const EGLint config_attribs[] = {
                EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
                EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT | EGL_OPENGL_ES3_BIT,
                EGL_RED_SIZE, 8,
                EGL_GREEN_SIZE, 8,
                EGL_BLUE_SIZE, 8,
                EGL_NONE
            };

            EGLint num_configs = 0;

            if (!eglChooseConfig(m_main_context.display, config_attribs, &m_main_context.config, 1, &num_configs) || num_configs == 0) {
                if (logger) logger->error("eglChooseConfig failed");
                return false;
            }

            // миниальный буфер
            const EGLint pbuffer_attribs[] = {
                EGL_WIDTH, 1,
                EGL_HEIGHT, 1,
                EGL_NONE
            };

            if (use_surface) {
                m_main_context.surface = eglCreatePbufferSurface(m_main_context.display, m_main_context.config, pbuffer_attribs);
                if (m_main_context.surface == EGL_NO_SURFACE) {
                    if (logger) logger->error("eglCreatePbufferSurface failed");
                    return false;
                }
            }
            else {
                m_main_context.surface = EGL_NO_SURFACE;
            }

            // Привязка API
            if (!eglBindAPI(EGL_OPENGL_ES_API)) {
                if (logger) logger->error("eglBindAPI failed");
                return false;
            }

            // контекст GLES 3
            const EGLint ctx_es3[] = {
                EGL_CONTEXT_CLIENT_VERSION, 3,
                EGL_NONE
            };

            m_main_context.context = eglCreateContext(
                m_main_context.display,
                m_main_context.config,
                EGL_NO_CONTEXT,
                ctx_es3
            );

            if (m_main_context.context == EGL_NO_CONTEXT) {
                if (logger) logger->info("ES3 context creation failed, fallback to ES2");
            }

            // Запуск контекста
            if (m_main_context.context != EGL_NO_CONTEXT) {
                if (!eglMakeCurrent(m_main_context.display, m_main_context.surface, m_main_context.surface, m_main_context.context)) {
                    EGLint err = eglGetError();
                    std::ostringstream oss;
                    oss << "eglMakeCurrent ES3 failed: 0x" << std::hex << err << std::dec;
                    logger->error(oss.str());
                    return false;
                }

                const char* ver = (const char*)glGetString(GL_VERSION);

                if (!ver) {
                    if (logger) logger->warn("ES3 context invalid, fallback to ES2");

                    eglDestroyContext(m_main_context.display, m_main_context.context);
                    m_main_context.context = EGL_NO_CONTEXT;
                }
            }

            // В случае, если нет GLES 3, то создаем контекст GLES 2
            if (m_main_context.context == EGL_NO_CONTEXT) {
                const EGLint ctx_es2[] = {
                    EGL_CONTEXT_CLIENT_VERSION, 2,
                    EGL_NONE
                };

                m_main_context.context = eglCreateContext(
                    m_main_context.display,
                    m_main_context.config,
                    EGL_NO_CONTEXT,
                    ctx_es2
                );

                if (m_main_context.context == EGL_NO_CONTEXT) {
                    if (logger) logger->error("Failed to create ES2 context");
                    return false;
                }

                // Не запустился - пиздец
                if (!eglMakeCurrent(m_main_context.display, m_main_context.surface, m_main_context.surface, m_main_context.context)) {
                    EGLint err = eglGetError();
                    std::ostringstream oss;
                    oss << "eglMakeCurrent (ES2) failed: 0x" << std::hex << err << std::dec;
                    logger->error(oss.str());
                    return false;
                }
            }

            if (logger) logger->info(dumpEGLFullDebug(m_main_context));

            // Проверка валидного GLES 
            const char* gl_ver = (const char*)glGetString(GL_VERSION);
            if (!gl_ver) {
                if (logger) logger->error("GL context is not functional");
                return false;
            }

            // Инициализация loader
            if (!g_gl.init(m_main_context.display, logger)) {
                if (logger) logger->error("GL extensions init failed");
                return false;
            }

            // Закрытие контекста
            if (!eglMakeCurrent(m_main_context.display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT)) {
                if (logger) logger->error("Cannot off egl context!");
            }

            m_is_initialzed = true;
            return true;
        }

        bool init_render_framebuffer(GLint width = 1024, GLint height = 1024, ULogger* logger = nullptr) {
            if (m_render_buffer_initialized) {
                if (logger) logger->warn("init_render_framebuffer(): render buffer reinitialization");
            }
            // Инициализация буфера для рисования кадров
            glGenFramebuffers(1, &m_fbo);
            glBindFramebuffer(GL_FRAMEBUFFER, m_fbo);

            GLuint depth;
            glGenRenderbuffers(1, &depth);
            glBindRenderbuffer(GL_RENDERBUFFER, depth);
            glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT16, width, height);
            glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth);

            glGenTextures(1, &m_fbo_texture);
            glBindTexture(GL_TEXTURE_2D, m_fbo_texture);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);

            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_fbo_texture, 0);

            if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
                if (logger) logger->error("FBO is not complete!");
                glBindFramebuffer(GL_FRAMEBUFFER, 0);
                return false;
            }

            // Отключаем FBO
            //glBindFramebuffer(GL_FRAMEBUFFER, 0);

            m_render_buffer_initialized = true;
            return true;
        }

        void destroy() {
            if (m_main_context.display != EGL_NO_DISPLAY) {

                eglMakeCurrent(m_main_context.display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);

                if (m_main_context.context != EGL_NO_CONTEXT) {
                    eglDestroyContext(m_main_context.display, m_main_context.context);
                    m_main_context.context = EGL_NO_CONTEXT;
                }

                if (m_main_context.surface != EGL_NO_SURFACE) {
                    eglDestroySurface(m_main_context.display, m_main_context.surface);
                    m_main_context.surface = EGL_NO_SURFACE;
                }

                eglTerminate(m_main_context.display);
                m_main_context.display = EGL_NO_DISPLAY;
            }
        }

        bool make_current(ULogger* logger = nullptr) {
            if (!eglMakeCurrent(m_main_context.display, m_main_context.surface, m_main_context.surface, m_main_context.context)) {
                if (logger) logger->error("eglMakeCurrent failed");
                return false;
            }
            return true;
        }

        bool undone_current(ULogger* logger = nullptr) {
            if (!eglMakeCurrent(m_main_context.display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT)) {
                if (logger) logger->error("eglMakeCurrent failed");
                return false;
            }
            return true;
        }

        bool create_shared_context(FEGLContext& shared_context, ULogger* logger = nullptr) {
            if (m_main_context.display == EGL_NO_DISPLAY || m_main_context.context == EGL_NO_CONTEXT) {
                if (logger) logger->error("create_shared_context(): main context not initialized");
                return false;
            }

            const EGLint context_attribs[] = {
                EGL_CONTEXT_CLIENT_VERSION, 3,
                EGL_NONE
            };

            EGLContext shared = eglCreateContext(
                m_main_context.display,
                m_main_context.config,         
                m_main_context.context,
                context_attribs
            );

            if (shared == EGL_NO_CONTEXT) {
                if (logger) logger->error("create_shared_context(): failed to create shared context!");
                return false;
            }

            shared_context.display = m_main_context.display;
            shared_context.context = shared;
            shared_context.config = m_main_context.config;

            return true;
        }

        bool create_shared_surface(EGLSurface& shared_surface, const FEGLContext& shared_context, ULogger* logger = nullptr) {
            const EGLint pbuffer_attribs[] = {
                EGL_WIDTH, 1,
                EGL_HEIGHT, 1,
                EGL_NONE
            };

            if (eglCreatePbufferSurface(shared_context.display, shared_context.config, pbuffer_attribs) == EGL_NO_SURFACE) {
                if (logger) logger->error("create_shared_surface(): cannot create shared surface for shared context!");
                return false;
            }
            return true;
        }

        static std::string ptrToHex(const void* p) {
            if (!p) return "NULL";
            std::ostringstream ss;
            ss << "0x" << std::hex << std::uppercase
                << reinterpret_cast<uintptr_t>(p);
            return ss.str();
        }

        static std::string eglSafeStr(const char* s) {
            return s ? std::string(s) : std::string("NULL");
        }

        static std::string detectEGLBackend(const char* exts) {
            if (!exts) return "unknown";

            std::string e(exts);

            if (e.find("EGL_KHR_platform_gbm") != std::string::npos ||
                e.find("EGL_MESA_platform_gbm") != std::string::npos)
                return "GBM (DRM headless)";

            if (e.find("EGL_KHR_platform_x11") != std::string::npos)
                return "X11";

            if (e.find("EGL_KHR_platform_wayland") != std::string::npos)
                return "Wayland";

            return "unknown";
        }

        std::string dumpEGLFullDebug(const FEGLContext& c) {
            std::ostringstream ss;

            ss << "[FEGLContext]\n";

            ss << "  display : " << ptrToHex(c.display) << "\n";
            ss << "  context : " << ptrToHex(c.context) << "\n";
            ss << "  surface : " << ptrToHex(c.surface) << "\n";
            ss << "  config  : " << ptrToHex(c.config) << "\n";

            if (c.display == EGL_NO_DISPLAY) {
                ss << "  ERROR: EGL_NO_DISPLAY\n";
                return ss.str();
            }

            const char* egl_vendor = eglQueryString(c.display, EGL_VENDOR);
            const char* egl_version = eglQueryString(c.display, EGL_VERSION);
            const char* egl_client = eglQueryString(c.display, EGL_CLIENT_APIS);
            const char* exts = eglQueryString(c.display, EGL_EXTENSIONS);

            const char* gl_ver = (const char*)glGetString(GL_VERSION);

            const char* gl_vendor = (const char*)glGetString(GL_VENDOR);
            const char* gl_renderer = (const char*)glGetString(GL_RENDERER);

            EGLContext current = eglGetCurrentContext();
            EGLDisplay current_dpy = eglGetCurrentDisplay();
            EGLSurface draw = eglGetCurrentSurface(EGL_DRAW);

            ss << "\n[EGL INFO]\n";
            ss << "  vendor   : " << eglSafeStr(egl_vendor) << "\n";
            ss << "  version  : " << eglSafeStr(egl_version) << "\n";
            ss << "  client   : " << eglSafeStr(egl_client) << "\n";

            ss << "\n[OpenGL]\n";
            ss << "  version  : " << (gl_ver ? gl_ver : "NULL") << "\n";
            ss << "  vendor   : " << (gl_vendor ? gl_vendor : "NULL") << "\n";
            ss << "  renderer : " << (gl_renderer ? gl_renderer : "NULL") << "\n";

            ss << "\n[BACKEND]\n";
            ss << "  detected : " << detectEGLBackend(exts) << "\n";

            ss << "\n[EXTENSIONS]\n";
            ss << "  " << eglSafeStr(exts) << "\n";

            ss << "\n[CURRENT]\n";
            ss << "  current context : " << (current == EGL_NO_CONTEXT ? "NO" : "YES") << "\n";
            ss << "  current display : " << (current_dpy == EGL_NO_DISPLAY ? "NO" : "YES") << "\n";
            ss << "  current surface : " << (draw == EGL_NO_SURFACE ? "NO" : "YES") << "\n";

            ss << "\n[STATUS]\n";
            if (c.context == EGL_NO_CONTEXT) {
                ss << "  context not created\n";
            }
            else {
                ss << "  context OK\n";
            }

            return ss.str();
        }
    };

} // varan
} // birdview
