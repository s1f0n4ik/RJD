#include <glm.hpp>
#include <gtc/matrix_transform.hpp>
#include <gtc/type_ptr.hpp>
#include <vector>
#include <cmath>
#include <algorithm>
#include <limits>

#include "bird-view/surround-renderer.h"
#include "bird-view/surround-bake.h"
#include "bird-view/constants.h"
#include "bird-view/utility.h"

namespace varan {
namespace birdview {

	namespace {

		constexpr float PI = 3.14159265358979f;

		// Плотный меш: линейная интерполяция UV не должна ломать кривизну fisheye
		// Сегменты раскладываются по длине контура, число адаптивно к периметру
		constexpr int BOWL_MIN_SEGMENTS = 96;
		constexpr int BOWL_MAX_SEGMENTS = 256;
		constexpr int BOWL_FLOOR_RINGS = 20;
		constexpr int BOWL_ARC_RINGS = 10;
		constexpr int BOWL_WALL_RINGS = 14;

		// Ручная орбита: полный проход экрана по X - полкруга, по Y - 90 градусов
		constexpr float ORBIT_DX_LAPS = 0.5f;
		constexpr float ORBIT_DY_DEGREES = 90.0f;
		constexpr float ORBIT_ZOOM_SENS = 1.0f;
		constexpr float ORBIT_PITCH_MAX = 45.0f;
		// Классический зум: кратность сужения поля зрения
		constexpr float ORBIT_ZOOM_MIN = 1.0f;
		constexpr float ORBIT_ZOOM_MAX = 4.0f;
		// Скорость стекания дистанции и наклона к целям, 1/с
		constexpr float ORBIT_EASE = 4.0f;
		// Нижний зажим радиуса углов пути, доля отступа: без изломов при corner 0
		constexpr float ORBIT_MIN_CORNER = 0.5f;

		struct FVertex {
			float px, py, pz;
			float nx, ny, nz;
		};

		// Точка на контуре-обкатке габарита с отступом off: прямые вдоль бортов
		// и дуги на углах, u - доля периметра, ход по нему равномерный
		glm::vec2 orbit_path_point(float u, float hx, float hz, float off, float corner_f) {
			const float c = std::clamp(std::max(corner_f, ORBIT_MIN_CORNER) * off,
				0.0f, std::min(hx, hz) + off);
			const float ex = hx + off - c;
			const float ez = hz + off - c;
			const float half_pi = PI * 0.5f;
			const float arc = std::max(c * half_pi, 1e-6f);
			const float lens[8] = { 2 * ez, arc, 2 * ex, arc, 2 * ez, arc, 2 * ex, arc };
			float perimeter = 0.0f;
			for (const float len : lens) perimeter += len;

			float t = (u - std::floor(u)) * perimeter;
			for (int i = 0; i < 8; ++i) {
				if (t > lens[i]) { t -= lens[i]; continue; }
				const float k = lens[i] > 1e-6f ? t / lens[i] : 0.0f;
				switch (i) {
				case 0: return { hx + off, -ez + 2 * ez * k };
				case 1: { const float p = k * half_pi;
					return { ex + c * std::cos(p), ez + c * std::sin(p) }; }
				case 2: return { ex - 2 * ex * k, hz + off };
				case 3: { const float p = half_pi + k * half_pi;
					return { -ex + c * std::cos(p), ez + c * std::sin(p) }; }
				case 4: return { -(hx + off), ez - 2 * ez * k };
				case 5: { const float p = PI + k * half_pi;
					return { -ex + c * std::cos(p), -ez + c * std::sin(p) }; }
				case 6: return { -ex + 2 * ex * k, -(hz + off) };
				case 7: { const float p = PI + half_pi + k * half_pi;
					return { ex + c * std::cos(p), -ez + c * std::sin(p) }; }
				}
			}
			return { hx + off, -ez };
		}

	} // namespace

	USurroundRenderer::~USurroundRenderer() {
		// Пробник и воркер фотонормализации гасятся до GL-ресурсов рендерера
		m_photo.reset();

		// Рендерер пересоздаётся на каждый запуск вывода, ресурсы надо вернуть
		destroy_geometry();
		clear_model_mesh();
		if (!m_cam_vbos.empty()) glDeleteBuffers(static_cast<GLsizei>(m_cam_vbos.size()), m_cam_vbos.data());
		if (m_accum_tex) glDeleteTextures(1, &m_accum_tex);
		if (m_accum_depth) glDeleteRenderbuffers(1, &m_accum_depth);
		if (m_accum_fbo) glDeleteFramebuffers(1, &m_accum_fbo);
	}

	void USurroundRenderer::destroy_geometry() {
		if (m_bowl_vbo) { glDeleteBuffers(1, &m_bowl_vbo); m_bowl_vbo = 0; }
		if (m_bowl_vao) { glDeleteVertexArrays(1, &m_bowl_vao); m_bowl_vao = 0; }
		if (m_box_vbo) { glDeleteBuffers(1, &m_box_vbo); m_box_vbo = 0; }
		if (m_box_vao) { glDeleteVertexArrays(1, &m_box_vao); m_box_vao = 0; }
	}

	bool USurroundRenderer::init(int textures_count, UEGLContextManager* context, ULogger* logger) {
		(void)textures_count;
		m_context = context;
		m_logger = logger;

		if (!context || !context->is_initialized()) {
			if (logger) logger->error("init(): egl context is not initialized at surround renderer!");
			return false;
		}

		auto vsh = constants::current_shader_path(constants::surround_vsh);
		auto fsh = constants::current_shader_path(constants::surround_fsh);
		if (!m_shader.load_from_files(vsh, fsh, logger)) {
			if (logger) logger->error("init(): surround shaders didn't load!");
			return false;
		}

		// Нормализация накопителя на полноэкранном треугольнике сшивки
		auto norm_vsh = constants::current_shader_path(constants::stitching_vsh);
		auto norm_fsh = constants::current_shader_path(constants::surround_norm_fsh);
		if (!m_normalize.load_from_files(norm_vsh, norm_fsh, logger)) {
			if (logger) logger->error("init(): surround normalize shader didn't load!");
			return false;
		}

		build_bowl();
		build_box();
		return true;
	}

	void USurroundRenderer::set_bowl_factors(float floor_f, float outer_f, float wall_f,
		float plate_f, float corner_f) {
		if (floor_f > 0) m_floor_f = floor_f;
		// Нулевой вынос допустим: вертикальная стенка
		if (outer_f >= 0) m_outer_f = outer_f;
		if (wall_f > 0) m_wall_f = wall_f;
		if (plate_f > 0) m_plate_f = plate_f;
		if (corner_f >= 0) m_corner_f = corner_f;
	}

	void USurroundRenderer::set_machine(float width, float height, float length) {
		if (width > 0) m_box_w = width;
		if (height > 0) m_box_h = height;
		if (length > 0) m_box_l = length;
		m_base = std::max(m_box_w, m_box_l);

		// Геометрия уже могла быть построена с размерами по умолчанию
		if (m_bowl_vao) {
			destroy_geometry();
			build_bowl();
			build_box();
		}
	}

	bool USurroundRenderer::set_camera_attributes(const std::vector<std::vector<float>>& cameras) {
		const size_t expected = m_positions.size() * SURROUND_ATTR_STRIDE;
		for (const auto& attrs : cameras) {
			if (attrs.size() != expected) {
				if (m_logger) m_logger->error("set_camera_attributes(): expected "
					+ std::to_string(expected) + " floats, got " + std::to_string(attrs.size()));
				return false;
			}
		}
		if (cameras.empty()) return false;

		if (!m_cam_vbos.empty()) {
			glDeleteBuffers(static_cast<GLsizei>(m_cam_vbos.size()), m_cam_vbos.data());
		}
		m_cam_vbos.assign(cameras.size(), 0);
		glGenBuffers(static_cast<GLsizei>(m_cam_vbos.size()), m_cam_vbos.data());

		for (size_t i = 0; i < cameras.size(); ++i) {
			glBindBuffer(GL_ARRAY_BUFFER, m_cam_vbos[i]);
			glBufferData(GL_ARRAY_BUFFER, cameras[i].size() * sizeof(float),
				cameras[i].data(), GL_STATIC_DRAW);
		}
		glBindBuffer(GL_ARRAY_BUFFER, 0);

		m_camera_count = static_cast<int>(cameras.size());
		m_cam_tex.assign(cameras.size(), {});
		return true;
	}

	void USurroundRenderer::set_photometric_pairs(const std::vector<FSurroundPhotoPair>& pairs) {
		// Перепечка приносит новые пары: пробник пересобирается общим модулем
		m_photo.setup(m_camera_count, pairs, m_logger);
	}

	void USurroundRenderer::build_bowl() {
		const float side = std::min(m_box_w, m_box_l);
		const float floor_off = side * m_floor_f;
		const float run_off = side * m_outer_f;
		// Дно только сдвигает начало стенки, вынос и наклон от него не зависят
		const float total_off = floor_off + run_off;
		const float wall_h = side * m_wall_f;

		// Профиль: дно → дуга стыка радиуса corner*side → прямая стенка
		// Наклон стенки задают вынос и высота; corner 0 с выносом 0 даёт
		// вертикальные стенки - параллелепипед
		std::vector<std::pair<float, float>> prof;
		{
			const float lw = std::hypot(run_off, wall_h);
			const float theta = std::atan2(wall_h, run_off);
			const float half_tan = std::tan(theta * 0.5f);
			const float r_fit = std::min(floor_off, lw) * 0.95f / std::max(half_tan, 1e-4f);
			const float R = std::clamp(m_corner_f * side, 0.0f, r_fit);
			const float t_tan = R * half_tan;
			const float wx = run_off / lw;
			const float wy = wall_h / lw;

			prof.reserve(BOWL_FLOOR_RINGS + BOWL_ARC_RINGS + BOWL_WALL_RINGS + 1);
			for (int i = 0; i <= BOWL_FLOOR_RINGS; ++i) {
				const float k = static_cast<float>(i) / BOWL_FLOOR_RINGS;
				prof.push_back({ (floor_off - t_tan) * k, 0.0f });
			}
			if (R > 1e-5f) {
				const float cx = floor_off - t_tan;
				for (int i = 1; i <= BOWL_ARC_RINGS; ++i) {
					const float phi = theta * static_cast<float>(i) / BOWL_ARC_RINGS;
					prof.push_back({ cx + R * std::sin(phi), R * (1.0f - std::cos(phi)) });
				}
			}
			for (int i = 1; i <= BOWL_WALL_RINGS; ++i) {
				const float k = t_tan + (lw - t_tan) * static_cast<float>(i) / BOWL_WALL_RINGS;
				prof.push_back({ floor_off + wx * k, wy * k });
			}
		}

		// Обкатка габарита: прямые участки вдоль бортов и дуги на углах
		// Радиус дуги кольца - доля его отступа: 0 - прямой угол, при факторе
		// больше единицы дуга съедает прямые участки и контур площе
		const float hx = m_box_w * 0.5f;
		const float hz = m_box_l * 0.5f;
		const float half_pi = PI * 0.5f;

		auto corner_r = [&](float off) {
			return std::clamp(m_corner_f * off, 0.0f, std::min(hx, hz) + off);
		};

		// Деление по u идёт от внешнего кольца, геометрия точки - от своего
		const float c_ref = corner_r(total_off);
		const float ref_ex = hx + total_off - c_ref;
		const float ref_ez = hz + total_off - c_ref;
		const float corner_ref = std::max(c_ref * half_pi, 1e-6f);
		const float ref_lens[8] = {
			2 * ref_ez, corner_ref, 2 * ref_ex, corner_ref,
			2 * ref_ez, corner_ref, 2 * ref_ex, corner_ref,
		};
		float perimeter = 0.0f;
		for (const float len : ref_lens) perimeter += len;

		auto contour_point = [&](float u, float off, float& x, float& z) {
			const float c = corner_r(off);
			// Центры дуг сдвинуты внутрь от углов на радиус скругления
			const float ex = hx + off - c;
			const float ez = hz + off - c;

			float t = u * perimeter;
			for (int i = 0; i < 8; ++i) {
				if (t > ref_lens[i]) { t -= ref_lens[i]; continue; }
				const float k = ref_lens[i] > 1e-6f ? t / ref_lens[i] : 0.0f;
				switch (i) {
				case 0: x = hx + off; z = -ez + 2 * ez * k; return;
				case 1: { const float p = k * half_pi;
					x = ex + c * std::cos(p); z = ez + c * std::sin(p); return; }
				case 2: x = ex - 2 * ex * k; z = hz + off; return;
				case 3: { const float p = half_pi + k * half_pi;
					x = -ex + c * std::cos(p); z = ez + c * std::sin(p); return; }
				case 4: x = -(hx + off); z = ez - 2 * ez * k; return;
				case 5: { const float p = PI + k * half_pi;
					x = -ex + c * std::cos(p); z = -ez + c * std::sin(p); return; }
				case 6: x = -ex + 2 * ex * k; z = -(hz + off); return;
				case 7: { const float p = PI + half_pi + k * half_pi;
					x = ex + c * std::cos(p); z = -ez + c * std::sin(p); return; }
				}
			}
			x = hx + off;
			z = -ez;
		};

		const int segments = std::clamp(static_cast<int>(perimeter / (side * 0.25f)),
			BOWL_MIN_SEGMENTS, BOWL_MAX_SEGMENTS);

		std::vector<FVertex> v;
		const int rings = static_cast<int>(prof.size()) - 1;
		v.reserve(static_cast<size_t>(rings) * segments * 6);

		for (int ring = 0; ring < rings; ++ring) {
			const float r0 = prof[static_cast<size_t>(ring)].first;
			const float h0 = prof[static_cast<size_t>(ring)].second;
			const float r1 = prof[static_cast<size_t>(ring) + 1].first;
			const float h1 = prof[static_cast<size_t>(ring) + 1].second;

			for (int seg = 0; seg < segments; ++seg) {
				const float u0 = static_cast<float>(seg) / segments;
				const float u1 = static_cast<float>(seg + 1) / segments;

				float x00, z00, x01, z01, x10, z10, x11, z11;
				contour_point(u0, r0, x00, z00);
				contour_point(u1, r0, x01, z01);
				contour_point(u0, r1, x10, z10);
				contour_point(u1, r1, x11, z11);

				const FVertex p00{ x00, h0, z00, 0, 1, 0 };
				const FVertex p01{ x01, h0, z01, 0, 1, 0 };
				const FVertex p10{ x10, h1, z10, 0, 1, 0 };
				const FVertex p11{ x11, h1, z11, 0, 1, 0 };

				v.push_back(p00); v.push_back(p10); v.push_back(p11);
				v.push_back(p11); v.push_back(p01); v.push_back(p00);
			}
		}

		m_bowl_vertices = static_cast<GLsizei>(v.size());

		// Позиции дублируются на CPU: их читает печка UV
		m_positions.clear();
		m_positions.reserve(v.size());
		for (const auto& vert : v) {
			m_positions.emplace_back(vert.px, vert.py, vert.pz);
		}

		glGenVertexArrays(1, &m_bowl_vao);
		glGenBuffers(1, &m_bowl_vbo);
		glBindVertexArray(m_bowl_vao);
		glBindBuffer(GL_ARRAY_BUFFER, m_bowl_vbo);
		glBufferData(GL_ARRAY_BUFFER, v.size() * sizeof(FVertex), v.data(), GL_STATIC_DRAW);
		glEnableVertexAttribArray(0);
		glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(FVertex), (void*)0);
		glEnableVertexAttribArray(1);
		glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, sizeof(FVertex), (void*)(3 * sizeof(float)));
		glBindVertexArray(0);
	}

	void USurroundRenderer::build_box() {
		// Модель может отличаться от габарита, платформа всегда от габарита
		const float x = (m_model_w > 0 ? m_model_w : m_box_w) * 0.5f;
		const float y = m_model_h > 0 ? m_model_h : m_box_h;
		const float z = (m_model_l > 0 ? m_model_l : m_box_l) * 0.5f;

		std::vector<FVertex> v;
		v.reserve(36);

		auto add_face = [&](glm::vec3 a, glm::vec3 b, glm::vec3 c, glm::vec3 d, glm::vec3 n) {
			v.push_back({ a.x, a.y, a.z, n.x, n.y, n.z });
			v.push_back({ b.x, b.y, b.z, n.x, n.y, n.z });
			v.push_back({ c.x, c.y, c.z, n.x, n.y, n.z });
			v.push_back({ c.x, c.y, c.z, n.x, n.y, n.z });
			v.push_back({ d.x, d.y, d.z, n.x, n.y, n.z });
			v.push_back({ a.x, a.y, a.z, n.x, n.y, n.z });
		};

		// Стоит на полу: низ y=0, верх y=высота машины
		add_face({ -x, 0,  z }, { x, 0,  z }, { x, y,  z }, { -x, y,  z }, { 0, 0, 1 });
		add_face({ x, 0, -z }, { -x, 0, -z }, { -x, y, -z }, { x, y, -z }, { 0, 0, -1 });
		add_face({ -x, 0, -z }, { -x, 0,  z }, { -x, y,  z }, { -x, y, -z }, { -1, 0, 0 });
		add_face({ x, 0,  z }, { x, 0, -z }, { x, y, -z }, { x, y,  z }, { 1, 0, 0 });
		add_face({ -x, y,  z }, { x, y,  z }, { x, y, -z }, { -x, y, -z }, { 0, 1, 0 });

		m_box_vertices = static_cast<GLsizei>(v.size());

		// Платформа: тёмный лист чуть выше пола; свои метры или габарит на фактор
		const float px = (m_plate_w_m > 0 ? m_plate_w_m : m_box_w * m_plate_f) * 0.5f;
		const float pz = (m_plate_l_m > 0 ? m_plate_l_m : m_box_l * m_plate_f) * 0.5f;
		const float py = m_base * 0.004f;
		add_face({ -px, py,  pz }, { px, py,  pz }, { px, py, -pz }, { -px, py, -pz }, { 0, 1, 0 });
		m_plate_vertices = static_cast<GLsizei>(v.size()) - m_box_vertices;

		glGenVertexArrays(1, &m_box_vao);
		glGenBuffers(1, &m_box_vbo);
		glBindVertexArray(m_box_vao);
		glBindBuffer(GL_ARRAY_BUFFER, m_box_vbo);
		glBufferData(GL_ARRAY_BUFFER, v.size() * sizeof(FVertex), v.data(), GL_STATIC_DRAW);
		glEnableVertexAttribArray(0);
		glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(FVertex), (void*)0);
		glEnableVertexAttribArray(1);
		glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, sizeof(FVertex), (void*)(3 * sizeof(float)));
		glBindVertexArray(0);
	}

	bool USurroundRenderer::ensure_accum() {
		if (m_accum_fbo) return true;

		glGenTextures(1, &m_accum_tex);
		glBindTexture(GL_TEXTURE_2D, m_accum_tex);
		glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA16F, m_out_w, m_out_h, 0, GL_RGBA, GL_HALF_FLOAT, nullptr);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);

		glGenRenderbuffers(1, &m_accum_depth);
		glBindRenderbuffer(GL_RENDERBUFFER, m_accum_depth);
		glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT16, m_out_w, m_out_h);

		glGenFramebuffers(1, &m_accum_fbo);
		glBindFramebuffer(GL_FRAMEBUFFER, m_accum_fbo);
		glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_accum_tex, 0);
		glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, m_accum_depth);

		if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
			if (m_logger) m_logger->error("ensure_accum(): accum FBO is not complete!");
			return false;
		}
		return true;
	}

	void USurroundRenderer::update(float dt) {
		bool manual;
		float dx, dy, dz;
		{
			std::lock_guard<std::mutex> lk(m_orbit_mutex);
			manual = m_orbit_manual;
			dx = m_pend_dx; dy = m_pend_dy; dz = m_pend_dzoom;
			m_pend_dx = m_pend_dy = m_pend_dzoom = 0.0f;
		}

		if (m_dist_cur <= 0.0f) m_dist_cur = m_orbit_dist_f;

		if (manual) {
			m_orbit_u += dx * ORBIT_DX_LAPS;
			m_pitch_off = std::clamp(m_pitch_off + dy * ORBIT_DY_DEGREES,
				-ORBIT_PITCH_MAX, ORBIT_PITCH_MAX);
			m_zoom = std::clamp(m_zoom * std::exp(dz * ORBIT_ZOOM_SENS),
				ORBIT_ZOOM_MIN, ORBIT_ZOOM_MAX);
		}
		else {
			// Темп слайдера сохранён: оборот занимает 2*pi/speed секунд
			m_orbit_u += dt * m_orbit_speed / (2.0f * PI);
			// Возврат в авто: взгляд и зум плавно стекают к базе
			m_pitch_off -= m_pitch_off * std::min(1.0f, dt * ORBIT_EASE);
			m_zoom += (1.0f - m_zoom) * std::min(1.0f, dt * ORBIT_EASE);
		}
		m_orbit_u -= std::floor(m_orbit_u);

		// Дистанция всегда следует конфигу: слайдер панели живой в обоих режимах
		m_dist_cur += (m_orbit_dist_f - m_dist_cur) * std::min(1.0f, dt * ORBIT_EASE);

		// Потолок наклона вверх из геометрии: кромка дальней стенки не опускается
		// ниже верхнего края кадра.
		// Пересчёт каждый кадр: отъезд зума расширяет угол и сам прижимает взгляд
		{
			const float side = std::min(m_box_w, m_box_l);
			const float off = std::max(m_base * (m_dist_cur - 0.5f), m_base * 0.25f);
			const glm::vec2 pos = orbit_path_point(m_orbit_u,
				m_box_w * 0.5f, m_box_l * 0.5f, off, m_corner_f);
			const float d_eye = std::max(std::hypot(pos.x, pos.y), 1e-3f);
			const float h_eye = m_base * m_orbit_height_f;
			// Ближайшая кромка дальней стенки: короткая полуось плюс дно с выносом
			const float d_rim = side * 0.5f + side * (m_floor_f + m_outer_f);
			const float h_rim = side * m_wall_f;
			const float fov_half = std::atan(std::tan(glm::radians(50.0f) * 0.5f) / m_zoom);
			const float elev_rim = std::atan2(h_rim - h_eye, d_eye + d_rim);
			const float elev_target = std::atan2(m_box_h * 0.4f - h_eye, d_eye);
			const float up_limit = std::clamp(
				glm::degrees(elev_rim - elev_target - fov_half),
				0.0f, ORBIT_PITCH_MAX);
			m_pitch_off = std::clamp(m_pitch_off, -ORBIT_PITCH_MAX, up_limit);
		}
	}

	void USurroundRenderer::set_orbit(float dist_f, float height_f, float speed) {
		if (dist_f > 0) m_orbit_dist_f = dist_f;
		if (height_f > 0) m_orbit_height_f = height_f;
		if (speed >= 0) m_orbit_speed = speed;
	}

	void USurroundRenderer::set_orbit_mode(bool manual) {
		std::lock_guard<std::mutex> lk(m_orbit_mutex);
		m_orbit_manual = manual;
	}

	void USurroundRenderer::apply_orbit_input(float dx, float dy, float dzoom) {
		std::lock_guard<std::mutex> lk(m_orbit_mutex);
		// В автооблёте дельты зрителей игнорируются
		if (!m_orbit_manual) return;
		m_pend_dx += dx;
		m_pend_dy += dy;
		m_pend_dzoom += dzoom;
	}

	void USurroundRenderer::set_plate(bool visible) {
		m_plate_visible = visible;
	}

	void USurroundRenderer::set_plate_size(float width_m, float length_m) {
		const float w = width_m > 0 ? width_m : 0.0f;
		const float l = length_m > 0 ? length_m : 0.0f;
		if (w == m_plate_w_m && l == m_plate_l_m) return;
		m_plate_w_m = w;
		m_plate_l_m = l;

		// Платформа лежит в буфере бокса, пересборка не трогает чашу и печку
		if (m_box_vao) {
			glDeleteBuffers(1, &m_box_vbo); m_box_vbo = 0;
			glDeleteVertexArrays(1, &m_box_vao); m_box_vao = 0;
			build_box();
		}
	}

	void USurroundRenderer::set_model(float width, float height, float length, float alpha) {
		m_model_w = width > 0 ? width : 0.0f;
		m_model_h = height > 0 ? height : 0.0f;
		m_model_l = length > 0 ? length : 0.0f;
		m_model_alpha = std::clamp(alpha, 0.0f, 1.0f);

		// Бокс лежит в своём VBO, пересборка не трогает чашу и печку
		if (m_box_vao) {
			glDeleteBuffers(1, &m_box_vbo); m_box_vbo = 0;
			glDeleteVertexArrays(1, &m_box_vao); m_box_vao = 0;
			build_box();
		}
	}

	void USurroundRenderer::set_wireframe(bool on) {
		m_wireframe = on;
	}

	void USurroundRenderer::clear_model_mesh() {
		if (m_model_vbo) { glDeleteBuffers(1, &m_model_vbo); m_model_vbo = 0; }
		if (m_model_vao) { glDeleteVertexArrays(1, &m_model_vao); m_model_vao = 0; }
		if (!m_model_textures.empty()) {
			glDeleteTextures(static_cast<GLsizei>(m_model_textures.size()), m_model_textures.data());
			m_model_textures.clear();
		}
		m_model_draws.clear();
		m_model_present = false;
	}

	bool USurroundRenderer::set_model_mesh(const FSurroundModel& model) {
		clear_model_mesh();
		if (model.vertices.empty() || model.primitives.empty()) return false;

		glGenVertexArrays(1, &m_model_vao);
		glGenBuffers(1, &m_model_vbo);
		glBindVertexArray(m_model_vao);
		glBindBuffer(GL_ARRAY_BUFFER, m_model_vbo);
		glBufferData(GL_ARRAY_BUFFER,
			model.vertices.size() * sizeof(float), model.vertices.data(), GL_STATIC_DRAW);
		const GLsizei stride = SURROUND_MODEL_STRIDE * sizeof(float);
		glEnableVertexAttribArray(0);
		glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, stride, (void*)0);
		glEnableVertexAttribArray(1);
		glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, stride, (void*)(3 * sizeof(float)));
		// Атрибут 2 в шейдере vec3, третья компонента добьётся нулём
		glEnableVertexAttribArray(2);
		glVertexAttribPointer(2, 2, GL_FLOAT, GL_FALSE, stride, (void*)(6 * sizeof(float)));
		glBindVertexArray(0);

		m_model_textures.assign(model.textures.size(), 0);
		if (!m_model_textures.empty()) {
			glGenTextures(static_cast<GLsizei>(m_model_textures.size()), m_model_textures.data());
			for (size_t i = 0; i < model.textures.size(); ++i) {
				const auto& tex = model.textures[i];
				glBindTexture(GL_TEXTURE_2D, m_model_textures[i]);
				glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, tex.width, tex.height, 0,
					GL_RGBA, GL_UNSIGNED_BYTE, tex.rgba.data());
				glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
				glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
				glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
				glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
			}
			glBindTexture(GL_TEXTURE_2D, 0);
		}

		m_model_draws.reserve(model.primitives.size());
		for (const auto& prim : model.primitives) {
			FModelDraw draw;
			draw.first = prim.first;
			draw.count = prim.count;
			draw.color = glm::vec4(prim.base_color[0], prim.base_color[1],
				prim.base_color[2], prim.base_color[3]);
			if (prim.texture >= 0 && prim.texture < static_cast<int>(m_model_textures.size())) {
				draw.texture = m_model_textures[static_cast<size_t>(prim.texture)];
			}
			m_model_draws.push_back(draw);
		}

		m_model_bbox_min = model.bbox_min;
		m_model_bbox_max = model.bbox_max;
		m_model_present = true;

		if (m_logger) m_logger->info("set_model_mesh(): vertices="
			+ std::to_string(model.vertices.size() / SURROUND_MODEL_STRIDE)
			+ ", primitives=" + std::to_string(model.primitives.size())
			+ ", textures=" + std::to_string(model.textures.size()));
		return true;
	}

	void USurroundRenderer::set_photometric_enabled(bool on) {
		m_photo.set_enabled(on);
	}

	void USurroundRenderer::update_textures(std::vector<NPFrame>& frames, EGLDisplay display) {
		(void)display;
		// Кадры приходят в порядке камер печки, как у сшивки
		for (size_t i = 0; i < m_cam_tex.size(); ++i) {
			auto& c = m_cam_tex[i];
			c.has_frame = false;
			c.plane_y_id = c.plane_uv_id = 0;

			if (i >= frames.size() || !frames[i]) continue;

			auto tex = std::dynamic_pointer_cast<USharedGLTextureWrapper>(frames[i]);
			if (!tex) continue;
			if (tex->format != "NV12" || tex->get_texure_count() < 2) continue;

			auto y_opt = tex->get_texture(0);
			auto uv_opt = tex->get_texture(1);
			if (!y_opt || !uv_opt) continue;

			c.plane_y_id = y_opt->id;
			c.plane_y_tg = y_opt->target;
			c.plane_uv_id = uv_opt->id;
			c.plane_uv_tg = uv_opt->target;
			c.has_frame = true;
		}
	}

	void USurroundRenderer::render(float aspect) {
		// Отступ пути от борта: на длинной оси дистанция равна прежнему радиусу
		const float dist = m_dist_cur > 0.0f ? m_dist_cur : m_orbit_dist_f;
		const float off = std::max(m_base * (dist - 0.5f), m_base * 0.25f);
		const glm::vec2 pos = orbit_path_point(m_orbit_u,
			m_box_w * 0.5f, m_box_l * 0.5f, off, m_corner_f);
		const glm::vec3 eye{ pos.x, m_base * m_orbit_height_f, pos.y };
		const glm::vec3 target{ 0.0f, m_box_h * 0.4f, 0.0f };

		glm::vec3 dir = glm::normalize(target - eye);
		if (m_pitch_off != 0.0f) {
			// Наклон взгляда вокруг горизонтальной оси, позиция не меняется
			const glm::vec3 right = glm::normalize(glm::cross(dir, glm::vec3(0, 1, 0)));
			const float a = glm::radians(m_pitch_off);
			dir = dir * std::cos(a) + glm::cross(right, dir) * std::sin(a);
		}

		// Зум сужает поле зрения через тангенс: честная кратность приближения
		const float fov = 2.0f * std::atan(std::tan(glm::radians(50.0f) * 0.5f) / m_zoom);
		glm::mat4 proj = glm::perspective(fov, aspect,
			m_base * 0.02f, m_base * 20.0f);
		// glReadPixels читает снизу вверх, кадр без переворота уехал бы вверх ногами
		proj[1][1] *= -1.0f;
		const glm::mat4 mvp = proj * glm::lookAt(eye, eye + dir, glm::vec3(0, 1, 0));

		m_shader.use();
		const GLuint prog = m_shader.get_id();
		glUniformMatrix4fv(glGetUniformLocation(prog, "u_mvp"), 1, GL_FALSE, glm::value_ptr(mvp));
		const GLint u_mode = glGetUniformLocation(prog, "u_mode");
		const GLint u_color = glGetUniformLocation(prog, "u_color");
		const GLint u_alpha = glGetUniformLocation(prog, "u_alpha");
		const GLint u_model = glGetUniformLocation(prog, "u_model");
		const GLint u_model_tex = glGetUniformLocation(prog, "u_model_tex");
		glUniform1f(glGetUniformLocation(prog, "u_grid_step"), m_base / 8.0f);
		glUniform1f(u_alpha, 1.0f);

		// Всё, кроме модели, рисуется в мировых координатах напрямую
		const glm::mat4 identity(1.0f);
		glUniformMatrix4fv(u_model, 1, GL_FALSE, glm::value_ptr(identity));

		// Вписывание модели: uniform-масштаб в габарит или в свои размеры,
		// центр по XZ, низ на пол, затем поворот вокруг вертикали
		glm::mat4 model_mat(1.0f);
		if (m_model_present) {
			const glm::vec3 size = m_model_bbox_max - m_model_bbox_min;
			const glm::vec3 center = (m_model_bbox_max + m_model_bbox_min) * 0.5f;
			const float tw = m_model_w > 0 ? m_model_w : m_box_w;
			const float th = m_model_h > 0 ? m_model_h : m_box_h;
			const float tl = m_model_l > 0 ? m_model_l : m_box_l;
			float s = std::numeric_limits<float>::max();
			if (size.x > 1e-6f) s = std::min(s, tw / size.x);
			if (size.y > 1e-6f) s = std::min(s, th / size.y);
			if (size.z > 1e-6f) s = std::min(s, tl / size.z);
			if (s == std::numeric_limits<float>::max()) s = 1.0f;
			model_mat = glm::rotate(glm::mat4(1.0f), glm::radians(m_model_rot), glm::vec3(0, 1, 0))
				* glm::scale(glm::mat4(1.0f), glm::vec3(s))
				* glm::translate(glm::mat4(1.0f),
					glm::vec3(-center.x, -m_model_bbox_min.y, -center.z));
		}

		// Меш модели; в depth_only уники цвета не трогаются, вывод замаскирован
		auto draw_model_mesh = [&](bool depth_only) {
			glUniformMatrix4fv(u_model, 1, GL_FALSE, glm::value_ptr(model_mat));
			glBindVertexArray(m_model_vao);
			for (const auto& d : m_model_draws) {
				if (!depth_only) {
					if (d.texture) {
						glUniform1i(u_mode, 3);
						glUniform1i(u_model_tex, 2);
						glActiveTexture(GL_TEXTURE2);
						glBindTexture(GL_TEXTURE_2D, d.texture);
					}
					else {
						glUniform1i(u_mode, 1);
					}
					glUniform3f(u_color, d.color.r, d.color.g, d.color.b);
					glUniform1f(u_alpha, m_model_alpha * d.color.a);
				}
				glDrawArrays(GL_TRIANGLES, d.first, d.count);
			}
			glActiveTexture(GL_TEXTURE0);
			glUniformMatrix4fv(u_model, 1, GL_FALSE, glm::value_ptr(identity));
			glUniform1f(u_alpha, 1.0f);
		};

		// Габарит и платформа поверх картинки, модель может быть полупрозрачной
		// Нормали бокса и подложки намотаны наружу, у чаши видимая сторона
		// внутренняя: после Y-флипа им нужны противоположные стороны отсечения
		auto draw_overlay = [&]() {
			glUniform1i(u_mode, 1);
			glBindVertexArray(m_box_vao);
			if (m_plate_visible) {
				glEnable(GL_CULL_FACE);
				glCullFace(GL_FRONT);
				glUniform3f(u_color, 0.09f, 0.10f, 0.12f);
				glDrawArrays(GL_TRIANGLES, m_box_vertices, m_plate_vertices);
				glDisable(GL_CULL_FACE);
			}
			if (m_model_alpha > 0.01f) {
				// Общий кусок отрисовки: меш целиком либо бокс-фолбэк
				auto draw_model = [&](bool depth_only) {
					if (m_model_present) {
						draw_model_mesh(depth_only);
					}
					else {
						glBindVertexArray(m_box_vao);
						if (!depth_only) {
							glUniform1f(u_alpha, m_model_alpha);
							glUniform3f(u_color, 0.62f, 0.16f, 0.14f);
						}
						glDrawArrays(GL_TRIANGLES, 0, m_box_vertices);
						if (!depth_only) glUniform1f(u_alpha, 1.0f);
					}
				};

				if (m_model_alpha < 0.99f) {
					/*
						Призрак одной поверхностью: сперва глубина модели без
						цвета, затем цвет строго по ней (GL_EQUAL). Один проход
						с блендингом рисовал грани в порядке буфера, и задние
						ложились ПОВЕРХ передних - перед модели пропадал.
					*/
					glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
					draw_model(true);
					glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);

					glDepthFunc(GL_EQUAL);
					glDepthMask(GL_FALSE);
					glEnable(GL_BLEND);
					glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
					draw_model(false);
					glDisable(GL_BLEND);
					glDepthMask(GL_TRUE);
					glDepthFunc(GL_LESS);
				}
				else if (m_model_present) {
					// Загруженный меш без отсечения: намотка чужих моделей
					// непредсказуема, GL_FRONT вырезал бы часть граней
					draw_model(false);
				}
				else {
					glEnable(GL_CULL_FACE);
					glCullFace(GL_FRONT);
					draw_model(false);
					glDisable(GL_CULL_FACE);
				}
			}
		};

		if (m_camera_count == 0 || m_wireframe) {
			// Без камер или в режиме сетки: чаша-сетка и габарит сразу в кадр
			glBindFramebuffer(GL_FRAMEBUFFER, m_context->get_fbo());
			glViewport(0, 0, m_out_w, m_out_h);
			glEnable(GL_DEPTH_TEST);
			glClearColor(0.07f, 0.08f, 0.10f, 1.0f);
			glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

			// Внешняя сторона чаши не рисуется: за её пределами обзор свободен
			glUniform1i(u_mode, 2);
			glUniform3f(u_color, 0.16f, 0.20f, 0.26f);
			glEnable(GL_CULL_FACE);
			glCullFace(GL_BACK);
			glBindVertexArray(m_bowl_vao);
			glDrawArrays(GL_TRIANGLES, 0, m_bowl_vertices);
			glDisable(GL_CULL_FACE);

			draw_overlay();

			glBindVertexArray(0);
			glDisable(GL_DEPTH_TEST);
			return;
		}

		if (!ensure_accum()) return;

		m_photo.probe_step(m_cam_tex);
		m_shader.use();

		// Препасс глубины: накопление пойдёт только по видимой поверхности,
		// иначе аддитивное смешивание сложило бы ближнюю и дальнюю стенки
		glBindFramebuffer(GL_FRAMEBUFFER, m_accum_fbo);
		glViewport(0, 0, m_out_w, m_out_h);
		glEnable(GL_DEPTH_TEST);
		glDepthFunc(GL_LESS);
		glDepthMask(GL_TRUE);
		glClearColor(0, 0, 0, 0);
		glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
		glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);

		// Отсечение в препассе совпадает с проходами камер: GL_EQUAL по глубине
		glEnable(GL_CULL_FACE);
		glCullFace(GL_BACK);
		glBindVertexArray(m_bowl_vao);
		glDrawArrays(GL_TRIANGLES, 0, m_bowl_vertices);
		// Прозрачная модель в глубину не пишется: она не должна гасить
		// накопление камер позади себя. Сторона отсечения бокса противоположна чаше
		glCullFace(GL_FRONT);
		if (m_model_alpha >= 0.99f) {
			if (m_model_present) {
				// Меш без отсечения: намотка чужих моделей непредсказуема
				glDisable(GL_CULL_FACE);
				draw_model_mesh(true);
				glEnable(GL_CULL_FACE);
			}
			else {
				glBindVertexArray(m_box_vao);
				glDrawArrays(GL_TRIANGLES, 0, m_box_vertices);
			}
		}
		glBindVertexArray(m_box_vao);
		if (m_plate_visible) glDrawArrays(GL_TRIANGLES, m_box_vertices, m_plate_vertices);
		glCullFace(GL_BACK);

		// Проходы камер: аддитивно, строго по глубине препасса
		glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
		glDepthMask(GL_FALSE);
		glDepthFunc(GL_EQUAL);
		glEnable(GL_BLEND);
		glBlendFunc(GL_ONE, GL_ONE);
		glBlendEquation(GL_FUNC_ADD);

		glUniform1i(u_mode, 0);
		glUniform1i(glGetUniformLocation(prog, "u_plane_y"), 0);
		glUniform1i(glGetUniformLocation(prog, "u_plane_uv"), 1);
		const GLint u_gain = glGetUniformLocation(prog, "u_gain");

		glBindVertexArray(m_bowl_vao);
		for (int i = 0; i < m_camera_count; ++i) {
			const auto& c = m_cam_tex[static_cast<size_t>(i)];
			if (!c.has_frame) continue;

			const glm::vec3 g = m_photo.gain(static_cast<size_t>(i));
			glUniform3f(u_gain, g.r, g.g, g.b);

			glBindBuffer(GL_ARRAY_BUFFER, m_cam_vbos[static_cast<size_t>(i)]);
			glEnableVertexAttribArray(2);
			glVertexAttribPointer(2, 3, GL_FLOAT, GL_FALSE, 3 * sizeof(float), (void*)0);

			glActiveTexture(GL_TEXTURE0);
			glBindTexture(c.plane_y_tg, c.plane_y_id);
			glActiveTexture(GL_TEXTURE1);
			glBindTexture(c.plane_uv_tg, c.plane_uv_id);

			glDrawArrays(GL_TRIANGLES, 0, m_bowl_vertices);
		}

		glDisable(GL_BLEND);
		glDisable(GL_CULL_FACE);
		glDepthMask(GL_TRUE);
		glDepthFunc(GL_LESS);
		glDisable(GL_DEPTH_TEST);

		// Нормализация накопителя в основной кадр
		glBindFramebuffer(GL_FRAMEBUFFER, m_context->get_fbo());
		glViewport(0, 0, m_out_w, m_out_h);
		m_normalize.use();
		glUniform1i(glGetUniformLocation(m_normalize.get_id(), "u_accum"), 0);
		glActiveTexture(GL_TEXTURE0);
		glBindTexture(GL_TEXTURE_2D, m_accum_tex);
		glBindVertexArray(0);
		glDrawArrays(GL_TRIANGLES, 0, 3);

		// Габарит поверх: орбита снаружи чаши, чаша его не заслоняет
		m_shader.use();
		glEnable(GL_DEPTH_TEST);
		glClear(GL_DEPTH_BUFFER_BIT);
		draw_overlay();

		glBindVertexArray(0);
		glDisable(GL_DEPTH_TEST);

		GLenum err = glGetError();
		if (err != GL_NO_ERROR && m_logger) {
			m_logger->error("USurroundRenderer::render(): GL error 0x" + std::to_string(err));
		}
	}

} // birdview
} // varan
