#include <glm.hpp>
#include <gtc/matrix_transform.hpp>
#include <gtc/type_ptr.hpp>
#include <vector>

#include "bird-view/renderer.h"
#include "bird-view/constants.h"

namespace varan {
namespace birdview {

	bool UCubeRenderer::init(int textures_count, ULogger* logger) {

		if (!m_context.init(m_logger)) {
			if (logger) logger->error("Failed initialize egl context at cube renderer initializtion!");
			return false;
		}

        auto vertex_path = constants::current_shader_path(constants::cube_vsh);
        auto fragment_path = constants::current_shader_path(constants::cube_fsh);
		if (m_shader.load_from_files(vertex_path, fragment_path, logger) == false) {
            if (logger) logger->error("init(): shaders didn't initialize, abort linker!");
			return false;
		}

		m_gl_images.resize(textures_count);
		m_logger = logger;

		create_cube();

		return true;
	}

	void UCubeRenderer::create_cube() {
        struct Vertex {
            float x, y, z;
            float u, v;
            float face;
        };

        std::vector<Vertex> v;

        auto add_face = [&](int face,
            glm::vec3 a,
            glm::vec3 b,
            glm::vec3 c,
            glm::vec3 d)
            {
                // 2 треугольника
                v.push_back({ a.x,a.y,a.z, 0,0,(float)face });
                v.push_back({ b.x,b.y,b.z, 1,0,(float)face });
                v.push_back({ c.x,c.y,c.z, 1,1,(float)face });

                v.push_back({ c.x,c.y,c.z, 1,1,(float)face });
                v.push_back({ d.x,d.y,d.z, 0,1,(float)face });
                v.push_back({ a.x,a.y,a.z, 0,0,(float)face });
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
        glVertexAttribPointer(2, 1, GL_FLOAT, GL_FALSE,
            sizeof(Vertex), (void*)(5 * sizeof(float)));

        glBindVertexArray(0);
	}

	void UCubeRenderer::update(float dt) {
		m_angle += dt;
	}

	void UCubeRenderer::update_textures(std::vector<std::optional<FDmabufFrame>>& frames, EGLDisplay display) {
		if (m_gl_images.size() == 0) {
			if (m_logger) m_logger->error("update_textures(): cannot update textures storage of textures not initialized!");
			return;
		}

		for (auto i = 0; i < m_gl_images.size(); ++i) {
			if (i >= frames.size()) {
                if (m_logger) m_logger->warn("update_textures(): index " + std::to_string(i) + " is out of range at frame storage. Cannot update texture");
                m_gl_images[i].create(display, std::nullopt, m_logger);
			}
			else {
				if (frames[i] == std::nullopt) {
                    if (m_logger) m_logger->warn("update_textures(): no frame at index " + std::to_string(i) + ". Creating texture fallback");
                    m_gl_images[i].create(display, std::nullopt, m_logger);
				}
				else {
					if (m_gl_images[i].create(display, std::move(frames[i].value()), m_logger) == false) {
                        if (m_logger) m_logger->trace("update_textures(): texture with index " + std::to_string(i) + " didn't update!");
					}
                    else {
                        if (m_logger) m_logger->trace("update_textures(): texture with index " + std::to_string(i) + " updated with new dma frame!");
                    }
				}
			}
		}
	}

    void UCubeRenderer::render(float aspect) {
        glm::mat4 proj = glm::perspective(1.0f, aspect, 0.1f, 100.0f);
        glm::mat4 view = glm::translate(glm::mat4(1.0f), glm::vec3(0, 0, -4));
        glm::mat4 model =
            glm::rotate(glm::mat4(1.0f), m_angle, glm::vec3(0, 1, 0)) *
            glm::rotate(glm::mat4(1.0f), m_angle * 0.5f, glm::vec3(1, 0, 0));

        glm::mat4 mvp = proj * view * model;

        m_shader.use();

        glUniformMatrix4fv(
            glGetUniformLocation(m_shader.get_id(), "MVP"),
            1, GL_FALSE,
            glm::value_ptr(mvp)
        );

        for (int i = 0; i < m_gl_images.size(); ++i)
        {
            int unit_y = i * 2;
            int unit_uv = i * 2 + 1;

            /*
            glActiveTexture(GL_TEXTURE0 + unit_y);
            glBindTexture(GL_TEXTURE_2D, m_gl_images[i].texture_y());

            glActiveTexture(GL_TEXTURE0 + unit_uv);
            glBindTexture(GL_TEXTURE_2D, m_gl_images[i].texture_uv());

            std::string y_name = "plane_y[" + std::to_string(i) + "]";
            std::string uv_name = "plane_uv[" + std::to_string(i) + "]";

            glUniform1i(glGetUniformLocation(m_shader.get_id(), y_name.c_str()), unit_y);
            glUniform1i(glGetUniformLocation(m_shader.get_id(), uv_name.c_str()), unit_uv);
            */
        }

        //glBindVertexArray(m_vao);
        //glDrawArrays(GL_TRIANGLES, 0, 36);
    }



} // birdview
} // varan