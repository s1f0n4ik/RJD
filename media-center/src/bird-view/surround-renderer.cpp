#include <glm.hpp>
#include <gtc/matrix_transform.hpp>
#include <gtc/type_ptr.hpp>
#include <vector>
#include <cmath>
#include <algorithm>

#include "bird-view/surround-renderer.h"
#include "bird-view/surround-bake.h"
#include "bird-view/constants.h"
#include "bird-view/utility.h"

namespace varan {
namespace birdview {

	namespace {

		constexpr float PI = 3.14159265358979f;

		constexpr float ORBIT_DIST_FACTOR = 3.4f;
		constexpr float ORBIT_HEIGHT_FACTOR = 2.0f;
		constexpr float ORBIT_SPEED = 0.25f;

		// Плотный меш: линейная интерполяция UV не должна ломать кривизну fisheye
		// Сегменты раскладываются по длине контура, число адаптивно к периметру
		constexpr int BOWL_MIN_SEGMENTS = 96;
		constexpr int BOWL_MAX_SEGMENTS = 256;
		constexpr int BOWL_FLOOR_RINGS = 20;
		constexpr int BOWL_WALL_RINGS = 14;

		struct FVertex {
			float px, py, pz;
			float nx, ny, nz;
		};

	} // namespace

	USurroundRenderer::~USurroundRenderer() {
		// Рендерер пересоздаётся на каждый запуск вывода, ресурсы надо вернуть
		destroy_geometry();
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

	void USurroundRenderer::set_bowl_factors(float floor_f, float outer_f, float wall_f, float plate_f) {
		if (floor_f > 0) m_floor_f = floor_f;
		if (outer_f > 0) m_outer_f = outer_f;
		if (wall_f > 0) m_wall_f = wall_f;
		if (plate_f > 0) m_plate_f = plate_f;
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

	void USurroundRenderer::build_bowl() {
		const float side = std::min(m_box_w, m_box_l);
		const float floor_off = side * m_floor_f;
		const float outer_off = side * m_outer_f;
		const float wall_h = side * m_wall_f;
		const float floor_part = floor_off / outer_off;

		// Точка профиля: отступ от борта, плоское дно, стенка загнута квадратичной дугой
		auto profile = [&](float t, float& offset, float& height) {
			if (t <= floor_part) {
				offset = outer_off * t;
				height = 0.0f;
				return;
			}
			const float wall_t = (t - floor_part) / (1.0f - floor_part);
			offset = floor_off + (outer_off - floor_off) * wall_t;
			height = wall_h * wall_t * wall_t;
		};

		// Обкатка габарита: кольцо - контур "прямоугольник + отступ наружу",
		// прямые участки вдоль бортов и четверти окружности на углах
		const float hx = m_box_w * 0.5f;
		const float hz = m_box_l * 0.5f;
		const float half_pi = PI * 0.5f;
		const float corner_ref = outer_off * half_pi;

		struct FSpan {
			float len;
			bool corner;
			float ax, az, bx, bz;
			float nx, nz;
			float phi0;
		};
		const FSpan spans[8] = {
			{ 2 * hz, false,  hx, -hz,  hx,  hz,  1,  0, 0 },
			{ corner_ref, true,  hx,  hz, 0, 0, 0, 0, 0 },
			{ 2 * hx, false,  hx,  hz, -hx,  hz,  0,  1, 0 },
			{ corner_ref, true, -hx,  hz, 0, 0, 0, 0, half_pi },
			{ 2 * hz, false, -hx,  hz, -hx, -hz, -1,  0, 0 },
			{ corner_ref, true, -hx, -hz, 0, 0, 0, 0, PI },
			{ 2 * hx, false, -hx, -hz,  hx, -hz,  0, -1, 0 },
			{ corner_ref, true,  hx, -hz, 0, 0, 0, 0, PI + half_pi },
		};
		float perimeter = 0.0f;
		for (const auto& s : spans) perimeter += s.len;

		// Параметр u общий для всех колец: вершины лежат на лучах от борта наружу
		auto contour_point = [&](float u, float off, float& x, float& z) {
			float t = u * perimeter;
			for (const auto& s : spans) {
				if (t > s.len) { t -= s.len; continue; }
				if (!s.corner) {
					const float k = t / s.len;
					x = s.ax + (s.bx - s.ax) * k + s.nx * off;
					z = s.az + (s.bz - s.az) * k + s.nz * off;
				}
				else {
					const float phi = s.phi0 + (t / s.len) * half_pi;
					x = s.ax + off * std::cos(phi);
					z = s.az + off * std::sin(phi);
				}
				return;
			}
			x = spans[7].ax + off * std::cos(spans[7].phi0 + half_pi);
			z = spans[7].az + off * std::sin(spans[7].phi0 + half_pi);
		};

		const int segments = std::clamp(static_cast<int>(perimeter / (side * 0.25f)),
			BOWL_MIN_SEGMENTS, BOWL_MAX_SEGMENTS);

		std::vector<FVertex> v;
		const int rings = BOWL_FLOOR_RINGS + BOWL_WALL_RINGS;
		v.reserve(static_cast<size_t>(rings) * segments * 6);

		for (int ring = 0; ring < rings; ++ring) {
			const float t0 = static_cast<float>(ring) / rings;
			const float t1 = static_cast<float>(ring + 1) / rings;
			float r0, h0, r1, h1;
			profile(t0, r0, h0);
			profile(t1, r1, h1);

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
		const float x = m_box_w * 0.5f;
		const float y = m_box_h;
		const float z = m_box_l * 0.5f;

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

		// Платформа: тёмный лист чуть выше пола, размер от габарита
		const float px = x * m_plate_f;
		const float pz = z * m_plate_f;
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
		m_yaw += dt * ORBIT_SPEED;
		if (m_yaw > 2.0f * PI) m_yaw -= 2.0f * PI;
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
		const glm::vec3 eye{
			m_base * ORBIT_DIST_FACTOR * std::cos(m_yaw),
			m_base * ORBIT_HEIGHT_FACTOR,
			m_base * ORBIT_DIST_FACTOR * std::sin(m_yaw)
		};
		const glm::vec3 target{ 0.0f, m_box_h * 0.4f, 0.0f };

		glm::mat4 proj = glm::perspective(glm::radians(50.0f), aspect,
			m_base * 0.02f, m_base * 20.0f);
		// glReadPixels читает снизу вверх, кадр без переворота уехал бы вверх ногами
		proj[1][1] *= -1.0f;
		const glm::mat4 mvp = proj * glm::lookAt(eye, target, glm::vec3(0, 1, 0));

		m_shader.use();
		const GLuint prog = m_shader.get_id();
		glUniformMatrix4fv(glGetUniformLocation(prog, "u_mvp"), 1, GL_FALSE, glm::value_ptr(mvp));
		const GLint u_mode = glGetUniformLocation(prog, "u_mode");
		const GLint u_color = glGetUniformLocation(prog, "u_color");
		glUniform1f(glGetUniformLocation(prog, "u_grid_step"), m_base / 8.0f);

		if (m_camera_count == 0) {
			// Камер нет: сетка и габарит сразу в основной кадр
			glBindFramebuffer(GL_FRAMEBUFFER, m_context->get_fbo());
			glViewport(0, 0, m_out_w, m_out_h);
			glEnable(GL_DEPTH_TEST);
			glClearColor(0.07f, 0.08f, 0.10f, 1.0f);
			glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

			glUniform1i(u_mode, 2);
			glUniform3f(u_color, 0.16f, 0.20f, 0.26f);
			glBindVertexArray(m_bowl_vao);
			glDrawArrays(GL_TRIANGLES, 0, m_bowl_vertices);

			glUniform1i(u_mode, 1);
			glUniform3f(u_color, 0.62f, 0.16f, 0.14f);
			glBindVertexArray(m_box_vao);
			glDrawArrays(GL_TRIANGLES, 0, m_box_vertices);

			glBindVertexArray(0);
			glDisable(GL_DEPTH_TEST);
			return;
		}

		if (!ensure_accum()) return;

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

		glBindVertexArray(m_bowl_vao);
		glDrawArrays(GL_TRIANGLES, 0, m_bowl_vertices);
		glBindVertexArray(m_box_vao);
		glDrawArrays(GL_TRIANGLES, 0, m_box_vertices + m_plate_vertices);

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

		glBindVertexArray(m_bowl_vao);
		for (int i = 0; i < m_camera_count; ++i) {
			const auto& c = m_cam_tex[static_cast<size_t>(i)];
			if (!c.has_frame) continue;

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
		glUniform1i(u_mode, 1);
		glBindVertexArray(m_box_vao);
		glUniform3f(u_color, 0.09f, 0.10f, 0.12f);
		glDrawArrays(GL_TRIANGLES, m_box_vertices, m_plate_vertices);
		glUniform3f(u_color, 0.62f, 0.16f, 0.14f);
		glDrawArrays(GL_TRIANGLES, 0, m_box_vertices);

		glBindVertexArray(0);
		glDisable(GL_DEPTH_TEST);

		GLenum err = glGetError();
		if (err != GL_NO_ERROR && m_logger) {
			m_logger->error("USurroundRenderer::render(): GL error 0x" + std::to_string(err));
		}
	}

} // birdview
} // varan
