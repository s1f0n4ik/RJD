#pragma once

#include <glm.hpp>

#include <condition_variable>
#include <mutex>
#include <thread>

#include "renderer.h"
#include "bird-view/surround-bake.h"
#include "bird-view/surround-model.h"

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

		// Пропорции чаши в долях от min(width, length): дно от борта, вынос
		// стенки от конца дна, скругление углов. Зовётся до set_machine
		void set_bowl_factors(float floor_f, float outer_f, float wall_f,
			float plate_f, float corner_f);

		// Фотонормализация: точки пар из печки, зовётся после set_camera_attributes
		// Повторный вызов пересобирает пробник под новую печку
		void set_photometric_pairs(const std::vector<FSurroundPhotoPair>& pairs);

		// Живые параметры, применяются со следующего кадра без перепечки
		void set_orbit(float dist_f, float height_f, float speed);
		// Размеры подложки в метрах; 0 - авто, габарит на фактор чаши
		void set_plate_size(float width_m, float length_m);
		// Ручное управление орбитой, зовётся из потока сокета камеры
		// true - автооблёт стоит, камеру двигают дельты; false - облёт с текущей точки
		void set_orbit_mode(bool manual);
		// Нормированные дельты жеста: доли канваса по осям и шаг зума
		void apply_orbit_input(float dx, float dy, float dzoom);
		void set_plate(bool visible);
		// Размеры модели-бокса в метрах, 0 - размер габарита; alpha 0 скрывает
		void set_model(float width, float height, float length, float alpha);
		// Загруженный .glb вместо параллелепипеда; зовётся из потока рендера
		bool set_model_mesh(const FSurroundModel& model);
		void clear_model_mesh();
		// Поворот модели вокруг вертикали в градусах
		void set_model_rotation(float degrees) { m_model_rot = degrees; }
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

		// Загруженная модель: рисуется вместо бокса, платформа остаётся боксовой
		struct FModelDraw {
			GLint first = 0;
			GLsizei count = 0;
			glm::vec4 color{ 1.0f };
			GLuint texture = 0;
		};
		GLuint m_model_vao = 0;
		GLuint m_model_vbo = 0;
		std::vector<FModelDraw> m_model_draws;
		std::vector<GLuint> m_model_textures;
		glm::vec3 m_model_bbox_min{ 0.0f };
		glm::vec3 m_model_bbox_max{ 0.0f };
		bool m_model_present = false;
		float m_model_rot = 0.0f;

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
		// Вынос стенки от конца дна: наклон стенки не зависит от размера дна
		float m_outer_f = 1.4f;
		float m_wall_f = 0.9f;
		float m_plate_f = 1.5f;
		// Скругление углов плана и стыка дна со стенкой: 0 - параллелепипед
		float m_corner_f = 1.0f;
		float m_box_w = 2.6f;
		float m_box_h = 3.6f;
		float m_box_l = 13.0f;

		// Живые параметры сцены, правятся ручкой /linker/surround
		float m_orbit_dist_f = 3.4f;
		float m_orbit_height_f = 2.0f;
		float m_orbit_speed = 0.25f;
		bool m_plate_visible = true;
		// Свои размеры подложки в метрах; 0 - от габарита на m_plate_f
		float m_plate_w_m = 0.0f;
		float m_plate_l_m = 0.0f;
		float m_model_w = 0.0f;
		float m_model_h = 0.0f;
		float m_model_l = 0.0f;
		float m_model_alpha = 1.0f;
		bool m_wireframe = false;
		bool m_photo_enabled = true;

		// Позиция камеры на скруглённом контуре габарита, доля периметра [0..1)
		float m_orbit_u = 0.0f;
		// Наклон взгляда от базы "на центр" в градусах, только в ручном режиме
		float m_pitch_off = 0.0f;
		// Сглаженная дистанция кадра; 0 - ещё не инициализирована
		float m_dist_cur = 0.0f;
		// Классический зум: сужение поля зрения, орбиту не трогает
		float m_zoom = 1.0f;

		// Вход с сокета: режим и накопленные дельты, забираются раз в кадр
		std::mutex m_orbit_mutex;
		bool m_orbit_manual = false;
		float m_pend_dx = 0.0f;
		float m_pend_dy = 0.0f;
		float m_pend_dzoom = 0.0f;

		int m_out_w = 0;
		int m_out_h = 0;

		UEGLContextManager* m_context = nullptr;
		ULogger* m_logger = nullptr;
	};

} // birdview
} // varan
