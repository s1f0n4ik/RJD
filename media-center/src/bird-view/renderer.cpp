#include <glm.hpp>
#include <gtc/matrix_transform.hpp>
#include <gtc/type_ptr.hpp>
#include <vector>
#include <chrono>
#include <iostream>

#include "bird-view/renderer.h"
#include "bird-view/constants.h"
#include "bird-view/utility.h"

namespace varan {
namespace birdview {

	bool UCubeRenderer::init(int textures_count, UEGLContextManager* context, ULogger* logger) {
		if (!context || !context->is_initialized()) {
			if (logger) logger->error("init(): failed locate initialized egl context at cube renderer!");
			return false;
		}

        auto vertex_path = constants::current_shader_path(constants::cube_vsh);
        auto fragment_path = constants::current_shader_path(constants::cube_fsh);
		if (m_shader.load_from_files(vertex_path, fragment_path, logger) == false) {
            if (logger) logger->error("init(): shaders didn't initialize, abort linker!");
			return false;
		}

		m_gl_images.resize(textures_count);

		create_cube();

        m_logger = logger;

		return true;
	}

	void UCubeRenderer::create_cube() {
        struct Vertex {
            float x, y, z;
            float u, v;
            int face;
        };

        std::vector<Vertex> v;

        auto add_face = [&](int face,
            glm::vec3 a,
            glm::vec3 b,
            glm::vec3 c,
            glm::vec3 d)
            {
                // 2 треугольника
                v.push_back({ a.x,a.y,a.z, 0,0,face });
                v.push_back({ b.x,b.y,b.z, 1,0,face });
                v.push_back({ c.x,c.y,c.z, 1,1,face });

                v.push_back({ c.x,c.y,c.z, 1,1,face });
                v.push_back({ d.x,d.y,d.z, 0,1,face });
                v.push_back({ a.x,a.y,a.z, 0,0,face });
            };

        // FRONT
        add_face(0,
            { -1,-1, 1 },
            { 1,-1, 1 },
            { 1, 1, 1 },
            { -1, 1, 1 });

        // BACK
        add_face(1,
            { 1,-1,-1 },
            { -1,-1,-1 },
            { -1, 1,-1 },
            { 1, 1,-1 });

        // LEFT
        add_face(2,
            { -1,-1,-1 },
            { -1,-1, 1 },
            { -1, 1, 1 },
            { -1, 1,-1 });

        // RIGHT
        add_face(3,
            { 1,-1, 1 },
            { 1,-1,-1 },
            { 1, 1,-1 },
            { 1, 1, 1 });

        // TOP
        add_face(4,
            { -1, 1, 1 },
            { 1, 1, 1 },
            { 1, 1,-1 },
            { -1, 1,-1 });

        // BOTTOM
        add_face(5,
            { -1,-1,-1 },
            { 1,-1,-1 },
            { 1,-1, 1 },
            { -1,-1, 1 });

        glGenVertexArrays(1, &m_vao);
        glGenBuffers(1, &m_vbo);

        glBindVertexArray(m_vao);
        glBindBuffer(GL_ARRAY_BUFFER, m_vbo);

        glBufferData(GL_ARRAY_BUFFER,
            v.size() * sizeof(Vertex),
            v.data(),
            GL_STATIC_DRAW);

        // pos
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE,
            sizeof(Vertex), (void*)0);

        // uv
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE,
            sizeof(Vertex), (void*)(3 * sizeof(float)));

        // faceId
        glEnableVertexAttribArray(2);
        glVertexAttribIPointer(2, 1, GL_INT, sizeof(Vertex), (void*)(5 * sizeof(float)));

        glBindVertexArray(0);
	}

	void UCubeRenderer::update(float dt) {
		m_angle += dt;
        if (m_logger) m_logger->trace("update: current angle: " + std::to_string(m_angle));
	}

	void UCubeRenderer::update_textures(std::vector<NPFrame>& frames, EGLDisplay display) {
		if (m_gl_images.size() == 0) {
			if (m_logger) m_logger->error("update_textures(): cannot update textures storage of textures not initialized!");
			return;
		}

		for (auto i = 0; i < m_gl_images.size(); ++i) {
			if (i >= frames.size()) {
                if (m_logger) m_logger->warn("update_textures(): index " + std::to_string(i) + " is out of range at frame storage. Cannot update texture");
                continue;
			}
            else if (auto new_texture = std::dynamic_pointer_cast<USharedGLTextureWrapper>(frames[i])) {
                m_gl_images[i] = std::move(new_texture);
                if (m_logger) m_logger->trace("update_textures() : frame with index " + std::to_string(i) + " successfully updated!");
            }
			else {
                if (!frames[i].get()) {
                    if (m_logger) m_logger->warn("update_textures(): frame with index " + std::to_string(i) + " is NULL!");
                }
                else {
                    if (m_logger) m_logger->warn("update_textures(): frame with index " + std::to_string(i) + " has not valid texture type: " 
                        + frames[i].get()->type() + " !" + "Must be USharedGLTextureWrapper that can be got from gstreamer gl pipeline!");
                }
                continue;
			}
		}
	}

    void UCubeRenderer::render(float aspect) {
        using namespace std::chrono;
        auto t_start = high_resolution_clock::now(); // старт таймера

        glm::mat4 proj = glm::perspective(45.0f, aspect, 0.1f, 100.0f);
        glm::mat4 view = glm::translate(glm::mat4(1.0f), glm::vec3(0, 0, -4));
        glm::mat4 model = glm::rotate(glm::mat4(1.0f), m_angle, glm::vec3(0.5f, 1.0f, 0));
        glm::mat4 mvp = proj * view * model;

        m_shader.use();

        glUniformMatrix4fv(
            glGetUniformLocation(m_shader.get_id(), "MVP"),
            1, GL_FALSE,
            glm::value_ptr(mvp)
        );

        int used_textures = 0;
        for (int i = 0; i < m_gl_images.size(); ++i) {
            auto frame = static_cast<USharedGLTextureWrapper*>(m_gl_images[i].get());

            auto is_texture_exists = frame != nullptr;
            auto is_nv12_format = is_texture_exists ? frame->format == "NV12" && frame->get_texure_count() == 2 : false;

            if (!is_texture_exists) {
                if (m_logger) m_logger->trace("Frame with index " + std::to_string(i) + " doesn't exist to render!");
            } else if (!is_nv12_format) {
                if (m_logger) m_logger->trace("Frame with index " + std::to_string(i) + " doesn't have nv12 format!");
            }

            std::string exists_uniform = "is_exists[" + std::to_string(i) + "]";
            glUniform1i(glGetUniformLocation(m_shader.get_id(), exists_uniform.c_str()), is_texture_exists && is_nv12_format ? 1 : 0);

            if (!(is_texture_exists && is_nv12_format)) {
                continue;
            }

            // Биндим текстуоы
            for (auto unit = 0; unit < frame->get_texure_count(); ++unit) {
                auto texture = frame->get_texture(unit);
                if (texture == std::nullopt) {
                    if (m_logger) m_logger->warn("Frame with index " + std::to_string(i) + " doesn't have valid OpenGL texture!");
                    continue;
                }
                std::string texture_uniform = unit == 0 ? "plane_y[" + std::to_string(i) + "]" : "plane_uv[" + std::to_string(i) + "]";
                glActiveTexture(GL_TEXTURE0 + i * 2 + unit);
                glBindTexture(texture.value().target, texture.value().id);
                glUniform1i(glGetUniformLocation(m_shader.get_id(), texture_uniform.c_str()), i * 2 + unit);
            }
        }

        glBindVertexArray(m_vao);
        glDrawArrays(GL_TRIANGLES, 0, 36);

        GLenum err = glGetError();
        if (err != GL_NO_ERROR) {
            if (m_logger) m_logger->error((std::ostringstream() << "OpenGL Error: " << glErrorString(err) << "(0x" << std::hex << err << std::dec << ")").str());
        }

        auto t_end = high_resolution_clock::now();
        double elapsed_ms = duration<double, std::milli>(t_end - t_start).count();

        std::ostringstream oss;
        oss << "render(): Render time: " << elapsed_ms << " ms, "
            << "textures used: " << used_textures << "/" << m_gl_images.size() << std::endl;
        if (m_logger) m_logger->trace(oss.str());
    }



} // birdview
} // varan
