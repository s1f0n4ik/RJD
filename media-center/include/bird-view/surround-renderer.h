#pragma once

#include <glm.hpp>

#include <condition_variable>
#include <mutex>
#include <thread>

#include "renderer.h"
#include "bird-view/surround-bake.h"

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

		// Отступы чаши от борта в долях от min(width, length), зовётся до set_machine
		void set_bowl_factors(float floor_f, float outer_f, float wall_f, float plate_f);

		// Фотонормализация: точки пар из печки, зовётся после set_camera_attributes
		// Повторный вызов пересобирает пробник под новую печку
		void set_photometric_pairs(const std::vector<FSurroundPhotoPair>& pairs);

		// Живые параметры, применяются со следующего кадра без перепечки
		void set_orbit(float dist_f, float height_f, float speed);
		void set_plate(bool visible);
		// Размеры модели-бокса в метрах, 0 - размер габарита; alpha 0 скрывает
		void set_model(float width, float height, float length, float alpha);
		void set_wireframe(bool on);
		void set_photometric_enabled(bool on);

	private:
		void build_bowl();
		void build_box();
		bool ensure_accum();
		void destroy_geometry();
		void probe_step();
		void photo_worker_loop();

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

		// Пробник фотонормализации: выборки пар в крошечный FBO, чтение через
		// PBO с fence без ожидания GPU, обсчёт в рабочем потоке
		struct FProbeDraw {
			int cam_a = 0;
			int cam_b = 0;
			GLint first_a = 0;
			GLint first_b = 0;
			GLsizei count = 0;
		};
		UShader m_probe;
		GLuint m_probe_vao = 0;
		GLuint m_probe_vbo = 0;
		GLuint m_probe_fbo = 0;
		GLuint m_probe_tex = 0;
		GLuint m_probe_pbo = 0;
		GLsync m_probe_fence = nullptr;
		int m_probe_w = 0;
		int m_probe_h = 0;
		int m_probe_frame = 0;
		std::vector<FProbeDraw> m_probe_pairs;

		// Применяемые усиления камер, копируются из воркера раз в кадр
		std::vector<glm::vec3> m_gains;

		std::thread m_photo_worker;
		std::mutex m_photo_mutex;
		std::condition_variable m_photo_cv;
		std::vector<uint8_t> m_photo_job;
		bool m_photo_job_ready = false;
		bool m_photo_stop = false;
		std::vector<glm::vec3> m_photo_gains;
		// Последнее измерение пары: страховка на тик без кадров
		std::vector<std::array<double, 3>> m_photo_last_m;
		std::vector<char> m_photo_last_ok;

		// База масштаба орбиты и сетки; отступы чаши идут от меньшей стороны
		float m_base = 4.0f;
		float m_floor_f = 0.9f;
		float m_outer_f = 2.3f;
		float m_wall_f = 0.9f;
		float m_plate_f = 1.5f;
		float m_box_w = 2.6f;
		float m_box_h = 3.6f;
		float m_box_l = 13.0f;

		// Живые параметры сцены, правятся ручкой /linker/surround
		float m_orbit_dist_f = 3.4f;
		float m_orbit_height_f = 2.0f;
		float m_orbit_speed = 0.25f;
		bool m_plate_visible = true;
		float m_model_w = 0.0f;
		float m_model_h = 0.0f;
		float m_model_l = 0.0f;
		float m_model_alpha = 1.0f;
		bool m_wireframe = false;
		bool m_photo_enabled = true;

		// Автооблёт, до появления ручного управления в третьем блоке
		float m_yaw = 0.0f;

		int m_out_w = 0;
		int m_out_h = 0;

		UEGLContextManager* m_context = nullptr;
		ULogger* m_logger = nullptr;
	};

} // birdview
} // varan
