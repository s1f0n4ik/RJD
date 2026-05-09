#pragma once
#include <GLES3/gl3.h>
#include <gst/gl/gl.h>
#include <gst/gst.h>

#include <string>
#include <unordered_map>

namespace varan {
	namespace glconstants {
	
		const std::string VGL_Y_PLANE = "y_plane";
		const std::string VGL_NV_PLANE = "nv_plane";
		const std::string VGL_Y_TEXTURE = "y_texture";
		const std::string VGL_NV_TEXTURE = "nv_texture";

	} // glconstants

    class UGLNV12Frame {
    public:
        struct UGLTexture {
            GLuint id_texture = 0;
            guint width = 0;
            guint height = 0;
            GsаtGLFormat format{};
            GstGLTextureTarget target{};
        };

        std::string format;
        uint32_t width = 0;
        uint32_t height = 0;
        uint64_t pts = 0;

        std::vector<UGLTexture> textures;

    public:
        UGLNV12Frame() = default;

        explicit UGLNV12Frame(GstBuffer* buffer): m_buffer(buffer) {
            if (m_buffer) {
                gst_buffer_ref(m_buffer);
            }
        }

        ~UGLNV12Frame() {
            release();
        }

        UGLNV12Frame(const UGLNV12Frame&) = delete;
        UGLNV12Frame& operator=(const UGLNV12Frame&) = delete;

        UGLNV12Frame(UGLNV12Frame&& other) noexcept {
            move_from(std::move(other));
        }

        UGLNV12Frame& operator=(UGLNV12Frame&& other) noexcept {
            if (this != &other) {
                release();
                move_from(std::move(other));
            }
            return *this;
        }

        GstBuffer* buffer() const {
            return m_buffer;
        }

    private:
        GstBuffer* m_buffer = nullptr;

    private:
        void release() {
            if (m_buffer) {
                gst_buffer_unref(m_buffer);
                m_buffer = nullptr;
            }
        }

        void move_from(UGLNV12Frame&& other) {
            format = std::move(other.format);
            width = other.width;
            height = other.height;
            pts = other.pts;

            textures = std::move(other.textures);

            m_buffer = other.m_buffer;
            other.m_buffer = nullptr;
        }
    };

} // varan