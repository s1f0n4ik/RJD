#include "core/image-converter.h"
#include "core/constants.h"

#include <filesystem>

namespace varan {

	void UImageConverter::create_plane() {
        float vertices[] = {
            // pos      // uv
            -1, -1,     0, 0,
             1, -1,     1, 0,
             1,  1,     1, 1,

             1,  1,     1, 1,
            -1,  1,     0, 1,
            -1, -1,     0, 0
        };

        glGenVertexArrays(1, &m_vao);
        glGenBuffers(1, &m_vbo);

        glBindVertexArray(m_vao);
        glBindBuffer(GL_ARRAY_BUFFER, m_vbo);

        glBufferData(GL_ARRAY_BUFFER, sizeof(vertices), vertices, GL_STATIC_DRAW);

        glEnableVertexAttribArray(0); // pos
        glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), (void*)0);

        glEnableVertexAttribArray(1); // uv
        glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), (void*)(2 * sizeof(float)));

        glBindVertexArray(0);
	}

    bool UImageConverter::init(ULogger* logger) {
        auto vertex_path = std::filesystem::current_path() / constants::nv12_converter_vsh;
        auto fragment_path = std::filesystem::current_path() / constants::nv12_converter_fsh;
        if (m_shader.load_from_files(vertex_path, fragment_path, logger) == false) {
            if (logger) logger->error("init(): shaders didn't initialize, abort linker!");
            return false;
        }

        create_plane();

        return true;
    }

    bool UImageConverter::create_fbo(int width, int height, ULogger* logger) {
        m_width = width;
        m_height = height;

        glGenFramebuffers(1, &m_framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);

        glGenTextures(1, &m_color_texture);
        glBindTexture(GL_TEXTURE_2D, m_color_texture);

        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, m_width, m_height, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);

        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);

        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_color_texture, 0);

        if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
            if (logger) logger->error("create_fbo(): cannot bind framebuffer");
            return false;
        }

        std::ostringstream oss;
        oss << "create_fbo(): Successfully created famebuffer with size: " << m_width << ", " << m_height;
        if (logger) logger->info(oss.str());
        return true;
    }

    bool UImageConverter::render(USharedGLTextureWrapper* frame, ULogger* logger) {
        if (!frame || frame->format != "NV12" || frame->get_texure_count() != 2) {
            return false;
        }

        m_shader.use();

        // Y
        auto texY = frame->get_texture(0).value();
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(texY.target, texY.id);
        glUniform1i(glGetUniformLocation(m_shader.get_id(), "texY"), 0);

        // UV
        auto texUV = frame->get_texture(1).value();
        glActiveTexture(GL_TEXTURE1);
        glBindTexture(texUV.target, texUV.id);
        glUniform1i(glGetUniformLocation(m_shader.get_id(), "texUV"), 1);

        glBindVertexArray(m_vao);
        glDrawArrays(GL_TRIANGLES, 0, 6);

        return true;
    }

    void UImageConverter::destroy_fbo() {
        if (m_color_texture) {
            glDeleteTextures(1, &m_color_texture);
            m_color_texture = 0;
        }

        if (m_framebuffer) {
            glDeleteFramebuffers(1, &m_framebuffer);
            m_framebuffer = 0;
        }

        m_width = 0;
        m_height = 0;
    }

    bool UImageConverter::bind_fbo() {
        if (m_framebuffer == 0) {
            return false;
        }
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glViewport(0, 0, m_width, m_height);

        return true;
    }

    void UImageConverter::unbind_fbo() {
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }

} // varan
