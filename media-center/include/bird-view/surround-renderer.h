#pragma once

#include <glm.hpp>

#include "renderer.h"

namespace varan {
namespace birdview {

	// Объёмный вид: чаша вокруг машины и орбитальная камера
	// Камеры накапливаются по проходу на каждую, число не ограничено
	// Без данных камер рисует сетку и габарит-параллелепипед
	class USurroundRenderer : public IRenderer {
	public:
		~USurroundRenderer() override;

		bool init(int textures_count, UEGLContextManager* context, ULogger* logger = nullptr) override;
		void update(float dt) override;
		void update_textures(std::vector<NPFrame>& frames, EGLDisplay display = nullptr) override;
		void render(float aspect) override;

		void set_output_size(int width, int height) { m_out_w = width; m_out_h = height; }

		// Вершины чаши в мировых метрах, вход для печки
		const std::vector<glm::vec3>& bowl_positions() const { return m_positions; }

		// Запечённые u,v,вес по 3 float на вершину, массив на камеру
		bool set_camera_attributes(const std::vector<std::vector<float>>& cameras);

		// Реальный габарит: масштабирует чашу, орбиту и параллелепипед
		void set_machine(float width, float height, float length);

		// Пропорции чаши в долях от base, зовётся до set_machine
		void set_bowl_factors(float floor_f, float outer_f, float wall_f, float plate_f);

	private:
		void build_bowl();
		void build_box();
		bool ensure_accum();
		void destroy_geometry();

	private:
		UShader m_shader;
		UShader m_normalize;

		GLuint m_bowl_vao = 0;
		GLuint m_bowl_vbo = 0;
		GLsizei m_bowl_vertices = 0;
		std::vector<glm::vec3> m_positions;
		std::vector<GLuint> m_cam_vbos;

		GLuint m_box_vao = 0;
		GLuint m_box_vbo = 0;
		GLsizei m_box_vertices = 0;
		// Платформа под машиной лежит в том же буфере после граней габарита
		GLsizei m_plate_vertices = 0;

		// Накопитель RGBA16F со своей глубиной, как у сшивки плюс препасс
		GLuint m_accum_fbo = 0;
		GLuint m_accum_tex = 0;
		GLuint m_accum_depth = 0;

		struct FCameraTex {
			GLuint plane_y_id = 0;
			GLuint plane_uv_id = 0;
			GLenum plane_y_tg = GL_TEXTURE_2D;
			GLenum plane_uv_tg = GL_TEXTURE_2D;
			bool has_frame = false;
		};
		std::vector<FCameraTex> m_cam_tex;
		int m_camera_count = 0;

		// База масштаба сцены, от неё чаша и орбита. По умолчанию машина
		float m_base = 4.0f;
		float m_floor_f = 1.4f;
		float m_outer_f = 2.8f;
		float m_wall_f = 0.9f;
		float m_plate_f = 1.5f;
		float m_box_w = 2.6f;
		float m_box_h = 3.6f;
		float m_box_l = 13.0f;

		// Автооблёт, до появления ручного управления в третьем блоке
		float m_yaw = 0.0f;

		int m_out_w = 0;
		int m_out_h = 0;

		UEGLContextManager* m_context = nullptr;
		ULogger* m_logger = nullptr;
	};

} // birdview
} // varan
