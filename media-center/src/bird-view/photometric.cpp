#include "bird-view/photometric.h"
#include "bird-view/constants.h"

#include <algorithm>
#include <cmath>

namespace varan {
namespace birdview {

	namespace {

		// Кадров между выборками, ~секунда на 25 fps
		constexpr int PROBE_INTERVAL = 25;
		constexpr float GAIN_MIN = 0.5f;
		constexpr float GAIN_MAX = 2.0f;
		constexpr float GAIN_EMA = 0.3f;

	} // namespace

	UPhotometric::~UPhotometric() {
		reset();
	}

	void UPhotometric::reset() {
		if (m_worker.joinable()) {
			{
				std::lock_guard<std::mutex> lk(m_mutex);
				m_stop = true;
				m_job_ready = false;
			}
			m_cv.notify_one();
			m_worker.join();
		}
		if (m_probe_fence) { glDeleteSync(m_probe_fence); m_probe_fence = nullptr; }
		if (m_probe_pbo) { glDeleteBuffers(1, &m_probe_pbo); m_probe_pbo = 0; }
		if (m_probe_vbo) { glDeleteBuffers(1, &m_probe_vbo); m_probe_vbo = 0; }
		if (m_probe_vao) { glDeleteVertexArrays(1, &m_probe_vao); m_probe_vao = 0; }
		if (m_probe_tex) { glDeleteTextures(1, &m_probe_tex); m_probe_tex = 0; }
		if (m_probe_fbo) { glDeleteFramebuffers(1, &m_probe_fbo); m_probe_fbo = 0; }
		m_probe_pairs.clear();
		m_probe_frame = 0;
		if (m_camera_count > 0) m_gains.assign(static_cast<size_t>(m_camera_count), glm::vec3(1.0f));
	}

	void UPhotometric::setup(int camera_count, const std::vector<FPhotoPair>& pairs, ULogger* logger) {
		reset();
		m_logger = logger;
		m_camera_count = camera_count;
		m_gains.assign(static_cast<size_t>(std::max(camera_count, 0)), glm::vec3(1.0f));

		if (pairs.empty() || camera_count < 2) return;

		auto vsh = constants::current_shader_path(constants::surround_probe_vsh);
		auto fsh = constants::current_shader_path(constants::surround_probe_fsh);
		if (!m_probe.load_from_files(vsh, fsh, m_logger)) {
			if (m_logger) m_logger->error("UPhotometric::setup(): probe shaders didn't load!");
			return;
		}

		// Строки FBO: чётная - выборки cam_a пары, нечётная - те же точки cam_b
		m_probe_w = PHOTO_SAMPLES;
		m_probe_h = static_cast<int>(pairs.size()) * 2;

		std::vector<float> verts;
		verts.reserve(static_cast<size_t>(m_probe_h) * m_probe_w * 4);
		m_probe_pairs.clear();
		GLint first = 0;
		for (size_t p = 0; p < pairs.size(); ++p) {
			const auto& pr = pairs[p];
			const GLsizei count = static_cast<GLsizei>(pr.uv.size());
			auto push_row = [&](int row, bool second) {
				const float ny = (static_cast<float>(row) + 0.5f) / m_probe_h * 2.0f - 1.0f;
				for (GLsizei s = 0; s < count; ++s) {
					const float nx = (static_cast<float>(s) + 0.5f) / m_probe_w * 2.0f - 1.0f;
					verts.push_back(nx);
					verts.push_back(ny);
					verts.push_back(second ? pr.uv[s][2] : pr.uv[s][0]);
					verts.push_back(second ? pr.uv[s][3] : pr.uv[s][1]);
				}
			};
			push_row(static_cast<int>(p) * 2, false);
			push_row(static_cast<int>(p) * 2 + 1, true);
			m_probe_pairs.push_back({ pr.cam_a, pr.cam_b, first, first + count, count });
			first += count * 2;
		}

		glGenVertexArrays(1, &m_probe_vao);
		glGenBuffers(1, &m_probe_vbo);
		glBindVertexArray(m_probe_vao);
		glBindBuffer(GL_ARRAY_BUFFER, m_probe_vbo);
		glBufferData(GL_ARRAY_BUFFER, verts.size() * sizeof(float), verts.data(), GL_STATIC_DRAW);
		glEnableVertexAttribArray(0);
		glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), (void*)0);
		glEnableVertexAttribArray(1);
		glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), (void*)(2 * sizeof(float)));
		glBindVertexArray(0);

		glGenTextures(1, &m_probe_tex);
		glBindTexture(GL_TEXTURE_2D, m_probe_tex);
		glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, m_probe_w, m_probe_h, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);

		glGenFramebuffers(1, &m_probe_fbo);
		glBindFramebuffer(GL_FRAMEBUFFER, m_probe_fbo);
		glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_probe_tex, 0);
		if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
			if (m_logger) m_logger->error("UPhotometric::setup(): probe FBO is not complete!");
			glBindFramebuffer(GL_FRAMEBUFFER, 0);
			glDeleteFramebuffers(1, &m_probe_fbo);
			m_probe_fbo = 0;
			return;
		}
		glBindFramebuffer(GL_FRAMEBUFFER, 0);

		glGenBuffers(1, &m_probe_pbo);
		glBindBuffer(GL_PIXEL_PACK_BUFFER, m_probe_pbo);
		glBufferData(GL_PIXEL_PACK_BUFFER,
			static_cast<GLsizeiptr>(m_probe_w) * m_probe_h * 4, nullptr, GL_STREAM_READ);
		glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);

		m_worker_gains.assign(static_cast<size_t>(m_camera_count), glm::vec3(1.0f));
		m_last_m.assign(m_probe_pairs.size(), { 0.0, 0.0, 0.0 });
		m_last_ok.assign(m_probe_pairs.size(), 0);
		m_stop = false;
		m_worker = std::thread([this] { worker_loop(); });

		if (m_logger) m_logger->info("UPhotometric::setup(): pairs="
			+ std::to_string(m_probe_pairs.size()));
	}

	void UPhotometric::probe_step(const std::vector<FPhotoPlanes>& planes) {
		if (!m_probe_fbo) return;

		// Выключенная нормализация: усиления единичные, пробник спит
		if (!m_enabled) {
			std::fill(m_gains.begin(), m_gains.end(), glm::vec3(1.0f));
			{
				std::lock_guard<std::mutex> lk(m_mutex);
				std::fill(m_worker_gains.begin(), m_worker_gains.end(), glm::vec3(1.0f));
			}
			return;
		}

		// Готовность чтения проверяется мгновенно, рендер не ждёт GPU
		if (m_probe_fence) {
			const GLenum st = glClientWaitSync(m_probe_fence, 0, 0);
			if (st == GL_ALREADY_SIGNALED || st == GL_CONDITION_SATISFIED) {
				glDeleteSync(m_probe_fence);
				m_probe_fence = nullptr;

				glBindBuffer(GL_PIXEL_PACK_BUFFER, m_probe_pbo);
				const size_t bytes = static_cast<size_t>(m_probe_w) * m_probe_h * 4;
				const void* src = glMapBufferRange(GL_PIXEL_PACK_BUFFER, 0,
					static_cast<GLsizeiptr>(bytes), GL_MAP_READ_BIT);
				if (src) {
					{
						std::lock_guard<std::mutex> lk(m_mutex);
						m_job.assign(static_cast<const uint8_t*>(src),
							static_cast<const uint8_t*>(src) + bytes);
						m_job_ready = true;
					}
					m_cv.notify_one();
					glUnmapBuffer(GL_PIXEL_PACK_BUFFER);
				}
				glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
			}
		}

		{
			std::lock_guard<std::mutex> lk(m_mutex);
			if (m_worker_gains.size() == m_gains.size()) m_gains = m_worker_gains;
		}

		if (m_probe_fence) return;
		if (++m_probe_frame < PROBE_INTERVAL) return;
		m_probe_frame = 0;

		glBindFramebuffer(GL_FRAMEBUFFER, m_probe_fbo);
		glViewport(0, 0, m_probe_w, m_probe_h);
		glDisable(GL_DEPTH_TEST);
		glClearColor(0.0f, 0.0f, 0.0f, 0.0f);
		glClear(GL_COLOR_BUFFER_BIT);

		m_probe.use();
		const GLuint prog = m_probe.get_id();
		glUniform1i(glGetUniformLocation(prog, "u_plane_y"), 0);
		glUniform1i(glGetUniformLocation(prog, "u_plane_uv"), 1);

		glBindVertexArray(m_probe_vao);
		for (const auto& d : m_probe_pairs) {
			if (d.cam_a < 0 || d.cam_b < 0) continue;
			if (static_cast<size_t>(d.cam_a) >= planes.size()
				|| static_cast<size_t>(d.cam_b) >= planes.size()) continue;
			const auto& ca = planes[static_cast<size_t>(d.cam_a)];
			const auto& cb = planes[static_cast<size_t>(d.cam_b)];
			// Пара без кадра остаётся чёрной, воркер отбросит её как насыщенную
			if (!ca.has_frame || !cb.has_frame) continue;

			glActiveTexture(GL_TEXTURE0);
			glBindTexture(ca.plane_y_tg, ca.plane_y_id);
			glActiveTexture(GL_TEXTURE1);
			glBindTexture(ca.plane_uv_tg, ca.plane_uv_id);
			glDrawArrays(GL_POINTS, d.first_a, d.count);

			glActiveTexture(GL_TEXTURE0);
			glBindTexture(cb.plane_y_tg, cb.plane_y_id);
			glActiveTexture(GL_TEXTURE1);
			glBindTexture(cb.plane_uv_tg, cb.plane_uv_id);
			glDrawArrays(GL_POINTS, d.first_b, d.count);
		}
		glBindVertexArray(0);

		// Чтение уходит в PBO и догоняется fence'ом в следующих кадрах
		glBindBuffer(GL_PIXEL_PACK_BUFFER, m_probe_pbo);
		glReadPixels(0, 0, m_probe_w, m_probe_h, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
		glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
		m_probe_fence = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
	}

	void UPhotometric::worker_loop() {
		std::vector<uint8_t> buf;
		std::vector<glm::vec3> gains(static_cast<size_t>(m_camera_count), glm::vec3(1.0f));
		const size_t n = static_cast<size_t>(m_camera_count);
		// Буфер решения фиксированный: больше 64 камер система не собирает
		if (n < 2 || n > 64) return;

		while (true) {
			{
				std::unique_lock<std::mutex> lk(m_mutex);
				m_cv.wait(lk, [this] { return m_job_ready || m_stop; });
				if (m_stop) return;
				buf.swap(m_job);
				m_job_ready = false;
			}

			// Лог-отношения пар по каналам, насыщенные выборки не считаются
			struct FEdge { int a; int b; double m[3]; };
			std::vector<FEdge> edges;
			for (size_t p = 0; p < m_probe_pairs.size(); ++p) {
				const auto& d = m_probe_pairs[p];
				double sum[3] = { 0.0, 0.0, 0.0 };
				int valid = 0;
				for (GLsizei s = 0; s < d.count; ++s) {
					const uint8_t* pa = buf.data()
						+ (static_cast<size_t>(p) * 2 * m_probe_w + s) * 4;
					const uint8_t* pb = buf.data()
						+ ((static_cast<size_t>(p) * 2 + 1) * m_probe_w + s) * 4;
					bool ok = true;
					for (int c = 0; c < 3; ++c) {
						if (pa[c] < 8 || pa[c] > 247 || pb[c] < 8 || pb[c] > 247) ok = false;
					}
					if (!ok) continue;
					for (int c = 0; c < 3; ++c) {
						sum[c] += std::log(pb[c] + 1.0) - std::log(pa[c] + 1.0);
					}
					++valid;
				}

				if (valid >= 8) {
					m_last_m[p] = { sum[0] / valid, sum[1] / valid, sum[2] / valid };
					m_last_ok[p] = 1;
				}
				if (!m_last_ok[p]) continue;
				edges.push_back({ d.cam_a, d.cam_b,
					{ m_last_m[p][0], m_last_m[p][1], m_last_m[p][2] } });
			}
			if (edges.empty()) continue;

			// Кольцевая система на log(gain): лапласиан пар плюс J/n прижимает
			// сумму логов к нулю - общий уровень яркости не дрейфует
			bool solved = true;
			glm::vec3 target[64];
			for (int c = 0; c < 3 && solved; ++c) {
				std::vector<double> M(n * n, 1.0 / n);
				std::vector<double> rhs(n, 0.0);
				for (const auto& e : edges) {
					M[e.a * n + e.a] += 1.0;
					M[e.b * n + e.b] += 1.0;
					M[e.a * n + e.b] -= 1.0;
					M[e.b * n + e.a] -= 1.0;
					rhs[e.a] += e.m[c];
					rhs[e.b] -= e.m[c];
				}

				for (size_t col = 0; col < n && solved; ++col) {
					size_t piv = col;
					for (size_t r = col + 1; r < n; ++r) {
						if (std::fabs(M[r * n + col]) > std::fabs(M[piv * n + col])) piv = r;
					}
					if (std::fabs(M[piv * n + col]) < 1e-9) { solved = false; break; }
					if (piv != col) {
						for (size_t k = 0; k < n; ++k) std::swap(M[col * n + k], M[piv * n + k]);
						std::swap(rhs[col], rhs[piv]);
					}
					for (size_t r = col + 1; r < n; ++r) {
						const double f = M[r * n + col] / M[col * n + col];
						for (size_t k = col; k < n; ++k) M[r * n + k] -= f * M[col * n + k];
						rhs[r] -= f * rhs[col];
					}
				}
				if (!solved) break;
				for (size_t r = n; r-- > 0;) {
					double acc = rhs[r];
					for (size_t k = r + 1; k < n; ++k) acc -= M[r * n + k] * (&target[k].x)[c];
					(&target[r].x)[c] = static_cast<float>(acc / M[r * n + r]);
				}
			}
			if (!solved) continue;

			for (size_t i = 0; i < n; ++i) {
				const glm::vec3 g = glm::clamp(glm::exp(target[i]),
					glm::vec3(GAIN_MIN), glm::vec3(GAIN_MAX));
				gains[i] = glm::mix(gains[i], g, GAIN_EMA);
			}

			{
				std::lock_guard<std::mutex> lk(m_mutex);
				m_worker_gains = gains;
			}
		}
	}

} // birdview
} // varan
