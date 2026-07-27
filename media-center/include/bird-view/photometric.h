#pragma once

#include <array>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

#include <glm.hpp>
#include <GLES3/gl3.h>

#include "logger.h"
#include "bird-view/shader.h"

namespace varan {
namespace birdview {

	// Точки одной земли глазами двух соседних камер, вход фотонормализации
	// uv - по паре нормированных координат на точку: ua, va, ub, vb
	struct FPhotoPair {
		int cam_a = 0;
		int cam_b = 0;
		std::vector<std::array<float, 4>> uv;
	};

	inline constexpr int PHOTO_SAMPLES = 256;

	// Плоскости NV12 камеры на текущий кадр, вход пробника
	struct FPhotoPlanes {
		GLuint plane_y_id = 0;
		GLuint plane_uv_id = 0;
		GLenum plane_y_tg = GL_TEXTURE_2D;
		GLenum plane_uv_tg = GL_TEXTURE_2D;
		bool has_frame = false;
	};

	/*
		Фотонормализация: выравнивание яркости и цвета соседних камер.

		Раз в PROBE_INTERVAL кадров сэмплирует пары точек в крошечный FBO,
		читает его через PBO с fence без ожидания GPU и отдаёт буфер рабочему
		потоку. Тот считает лог-отношения пар, решает кольцевую систему на
		log(gain) и сглаживает результат EMA. Рендерер забирает усиления
		методом gain() и умножает на них цвет камеры в своём шейдере.

		Общая для top и surround: обе сшивки кормят её парами своей печки.
	*/
	class UPhotometric {
	public:
		~UPhotometric();

		// Пересборка под новую печку; пустые пары или < 2 камер гасят пробник
		// Зовётся из потока рендера с текущим GL-контекстом
		void setup(int camera_count, const std::vector<FPhotoPair>& pairs, ULogger* logger);

		// Полный сброс: воркер, GL-ресурсы, усиления в единицы
		void reset();

		void set_enabled(bool on) { m_enabled = on; }

		// Кадровый шаг: выборка, чтение и обмен с воркером; planes - в порядке
		// индексов камер из пар
		void probe_step(const std::vector<FPhotoPlanes>& planes);

		glm::vec3 gain(size_t cam) const {
			return cam < m_gains.size() ? m_gains[cam] : glm::vec3(1.0f);
		}

	private:
		void worker_loop();

	private:
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

		int m_camera_count = 0;
		bool m_enabled = true;

		// Применяемые усиления камер, копируются из воркера раз в кадр
		std::vector<glm::vec3> m_gains;

		std::thread m_worker;
		std::mutex m_mutex;
		std::condition_variable m_cv;
		std::vector<uint8_t> m_job;
		bool m_job_ready = false;
		bool m_stop = false;
		std::vector<glm::vec3> m_worker_gains;
		// Последнее измерение пары: страховка на тик без кадров
		std::vector<std::array<double, 3>> m_last_m;
		std::vector<char> m_last_ok;

		ULogger* m_logger = nullptr;
	};

} // birdview
} // varan
