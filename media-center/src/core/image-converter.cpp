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

    bool UImageConverter::init(ULogger* logger, bool with_remap) {
        m_with_remap = with_remap;

        auto vertex_path = std::filesystem::current_path() / constants::nv12_converter_vsh;
        auto fragment_path = std::filesystem::current_path()
            / (with_remap ? constants::undist_fsh : constants::nv12_converter_fsh);
        if (m_shader.load_from_files(vertex_path, fragment_path, logger) == false) {
            if (logger) logger->error("init(): shaders didn't initialize, abort linker!");
            return false;
        }

        create_plane();

        return true;
    }

    GLuint UImageConverter::upload_map(const cv::Mat& map) {
        GLuint texture = 0;
        glGenTextures(1, &texture);
        glBindTexture(GL_TEXTURE_2D, texture);

        // Float-текстуры в GLES без расширения нефильтруемы — только NEAREST
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

        glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_R32F, map.cols, map.rows, 0, GL_RED, GL_FLOAT, map.ptr<float>());
        glBindTexture(GL_TEXTURE_2D, 0);

        return texture;
    }

    bool UImageConverter::set_maps(const cv::Mat& map_x, const cv::Mat& map_y, ULogger* logger) {
        if (!m_with_remap) {
            if (logger) logger->error("set_maps(): converter initialized without remap mode");
            return false;
        }

        if (map_x.empty() || map_y.empty() || map_x.type() != CV_32FC1 || map_y.type() != CV_32FC1
            || map_x.size() != map_y.size()) {
            if (logger) logger->error("set_maps(): maps must be non-empty CV_32FC1 of equal size");
            return false;
        }

        // glTexImage2D читает подряд — несплошную матрицу уплотняем
        const cv::Mat cont_x = map_x.isContinuous() ? map_x : map_x.clone();
        const cv::Mat cont_y = map_y.isContinuous() ? map_y : map_y.clone();

        m_map_x_texture = upload_map(cont_x);
        m_map_y_texture = upload_map(cont_y);
        m_map_width = map_x.cols;
        m_map_height = map_x.rows;

        if (!m_map_x_texture || !m_map_y_texture) {
            if (logger) logger->error("set_maps(): cannot create map textures");
            return false;
        }

        if (logger) logger->info("set_maps(): uploaded undist maps "
            + std::to_string(m_map_width) + "x" + std::to_string(m_map_height));
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

        if (m_with_remap && (!m_map_x_texture || !m_map_y_texture)) {
            if (logger) logger->error("render(): remap mode without uploaded maps");
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

        if (m_with_remap) {
            glActiveTexture(GL_TEXTURE2);
            glBindTexture(GL_TEXTURE_2D, m_map_x_texture);
            glUniform1i(glGetUniformLocation(m_shader.get_id(), "mapX"), 2);

            glActiveTexture(GL_TEXTURE3);
            glBindTexture(GL_TEXTURE_2D, m_map_y_texture);
            glUniform1i(glGetUniformLocation(m_shader.get_id(), "mapY"), 3);

            glUniform2f(glGetUniformLocation(m_shader.get_id(), "srcSize"),
                static_cast<float>(frame->width), static_cast<float>(frame->height));
        }

        glBindVertexArray(m_vao);
        glDrawArrays(GL_TRIANGLES, 0, 6);

        return true;
    }

    void UImageConverter::destroy_fbo() {
        // Карты чистятся здесь же: контекст ещё текущий, деструктор его не застанет
        if (m_map_x_texture) {
            glDeleteTextures(1, &m_map_x_texture);
            m_map_x_texture = 0;
        }
        if (m_map_y_texture) {
            glDeleteTextures(1, &m_map_y_texture);
            m_map_y_texture = 0;
        }

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
