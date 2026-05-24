#include "bird-view/renderer.h"
#include "bird-view/constants.h"
#include "bird-view/utility.h"

#include "utility/gl-maps.h"

#include <boost/json.hpp>
#include <fstream>
#include <sstream>

namespace varan {
namespace birdview {

    bool UStitchRenderer::init(int textures_count, UEGLContextManager* context, ULogger* logger) {
        m_context = context;
        m_logger = logger;

        if (!context || !context->is_initialized()) {
            if (m_logger) m_logger->error("UStitchRenderer::init(): bad context");
            return false;
        }

        // Шейдеры. Имена путей подставь свои (как в constants для cube).
        auto vsh = constants::current_shader_path(constants::stitching_vsh);
        auto fs1 = constants::current_shader_path(constants::stitching_fsh);
        auto fs2 = constants::current_shader_path(constants::normalize_fsh);

        if (!m_stitch.load_from_files(vsh, fs1, m_logger)) return false;
        if (!m_normalize.load_from_files(vsh, fs2, m_logger)) return false;

        return true;
    }

    bool UStitchRenderer::init_accum_fbo() {
        if (m_canvas_w <= 0 || m_canvas_h <= 0) return false;

        if (m_accum_tex) { glDeleteTextures(1, &m_accum_tex); m_accum_tex = 0; }
        if (m_accum_fbo) { glDeleteFramebuffers(1, &m_accum_fbo); m_accum_fbo = 0; }

        glGenTextures(1, &m_accum_tex);
        glBindTexture(GL_TEXTURE_2D, m_accum_tex);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA16F, m_canvas_w, m_canvas_h, 0,
            GL_RGBA, GL_HALF_FLOAT, nullptr);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

        glGenFramebuffers(1, &m_accum_fbo);
        glBindFramebuffer(GL_FRAMEBUFFER, m_accum_fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
            GL_TEXTURE_2D, m_accum_tex, 0);

        const bool ok = (glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        if (!ok && m_logger) m_logger->error("UStitchRenderer: accum FBO incomplete");
        return ok;
    }

    bool UStitchRenderer::load_export(const std::filesystem::path& exports_root,
        const std::filesystem::path& index_json,
        const std::string& export_id)
    {
        destroy_resources();

        // 1) Парсим JSON-индекс.
        auto configs_path = exports_root / index_json;
        std::ifstream f(configs_path);
        if (!f.is_open()) {
            if (m_logger) m_logger->error("load_export(): cannot open " + configs_path.string());
            return false;
        }
        std::stringstream ss; ss << f.rdbuf();
        boost::json::value v;
        try { v = boost::json::parse(ss.str()); }
        catch (...) {
            if (m_logger) m_logger->error("load_export(): json parse error");
            return false;
        }
        if (!v.is_object()) {
            if (m_logger) m_logger->error("load_export(): bad json root");
            return false;
        }
        const auto& root = v.as_object();
        auto it = root.find(export_id);
        if (it == root.end() || !it->value().is_object()) {
            if (m_logger) m_logger->error("load_export(): export <" + export_id + "> not found");
            return false;
        }
        const auto& obj = it->value().as_object();

        m_canvas_w = obj.contains("width") ? static_cast<int>(obj.at("width").as_int64()) : 0;
        m_canvas_h = obj.contains("height") ? static_cast<int>(obj.at("height").as_int64()) : 0;
        if (m_canvas_w <= 0 || m_canvas_h <= 0) {
            if (m_logger) m_logger->error("load_export(): bad canvas size");
            return false;
        }

        auto cams_v = obj.if_contains("cameras");
        if (!cams_v || !cams_v->is_object()) {
            if (m_logger) m_logger->error("load_export(): no cameras");
            return false;
        }

        // 2) Создаём текстуры remap/weight для каждой камеры.
        for (const auto& [key, cam_v] : cams_v->as_object()) {
            if (!cam_v.is_object()) continue;
            const auto& co = cam_v.as_object();
            if (!co.contains("remap") || !co.contains("weight")) continue;

            const std::string remap_rel = std::string(co.at("remap").as_string().c_str());
            const std::string weight_rel = std::string(co.at("weight").as_string().c_str());

            int rw = 0, rh = 0;
            GLuint remap_tex = gl_maps::load_gl_map(exports_root / remap_rel, rw, rh, m_logger);
            if (!remap_tex) continue;

            int ww = 0, wh = 0;
            GLuint weight_tex = gl_maps::load_gl_map(exports_root / weight_rel, ww, wh, m_logger);
            if (!weight_tex) {
                glDeleteTextures(1, &remap_tex);
                continue;
            }

            FCameraGL c{};
            c.remap = remap_tex;
            c.weight = weight_tex;
            std::string cam_key(key);
            m_cams.emplace(cam_key, c);
            m_ordered_keys.push_back(std::move(cam_key));
        }

        if (m_cams.empty()) {
            if (m_logger) m_logger->error("load_export(): no cameras loaded");
            return false;
        }

        if (!init_accum_fbo()) return false;

        if (m_logger) m_logger->info("load_export(): loaded <" + export_id + "> with " + std::to_string(m_cams.size()) + " cameras");
        return true;
    }

    void UStitchRenderer::update(float /*dt*/) {
        // Состояния нет.
    }

    void UStitchRenderer::update_textures(std::vector<NPFrame>& frames, EGLDisplay /*display*/) {
        // frames приходят в порядке m_ordered_keys.
        for (size_t i = 0; i < m_ordered_keys.size(); ++i) {
            const auto& key = m_ordered_keys[i];
            auto cam_it = m_cams.find(key);
            if (cam_it == m_cams.end()) continue;
            auto& c = cam_it->second;

            c.has_frame = false;
            c.plane_y_id = c.plane_uv_id = 0;

            if (i >= frames.size() || !frames[i]) continue;

            auto* tex = dynamic_cast<UGLTextureWrapper*>(frames[i].get());
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

    void UStitchRenderer::render(float /*aspect*/) {
        if (!m_accum_fbo) return;

        // --- Pass 1: накопление ---
        glBindFramebuffer(GL_FRAMEBUFFER, m_accum_fbo);
        glViewport(0, 0, m_canvas_w, m_canvas_h);
        glClearColor(0, 0, 0, 0);
        glClear(GL_COLOR_BUFFER_BIT);

        glEnable(GL_BLEND);
        glBlendFunc(GL_ONE, GL_ONE);
        glBlendEquation(GL_FUNC_ADD);
        glDisable(GL_DEPTH_TEST);

        m_stitch.use();
        const GLint u_remap = glGetUniformLocation(m_stitch.get_id(), "u_remap");
        const GLint u_weight = glGetUniformLocation(m_stitch.get_id(), "u_weight");
        const GLint u_plane_y = glGetUniformLocation(m_stitch.get_id(), "u_plane_y");
        const GLint u_plane_uv = glGetUniformLocation(m_stitch.get_id(), "u_plane_uv");
        const GLint u_has_frame = glGetUniformLocation(m_stitch.get_id(), "u_has_frame");

        glUniform1i(u_remap, 0);
        glUniform1i(u_weight, 1);
        glUniform1i(u_plane_y, 2);
        glUniform1i(u_plane_uv, 3);

        for (const auto& key : m_ordered_keys) {
            auto& c = m_cams[key];

            glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D, c.remap);
            glActiveTexture(GL_TEXTURE1); glBindTexture(GL_TEXTURE_2D, c.weight);

            if (c.has_frame) {
                glActiveTexture(GL_TEXTURE2); glBindTexture(c.plane_y_tg, c.plane_y_id);
                glActiveTexture(GL_TEXTURE3); glBindTexture(c.plane_uv_tg, c.plane_uv_id);
                glUniform1i(u_has_frame, 1);
            }
            else {
                glUniform1i(u_has_frame, 0);
            }

            glDrawArrays(GL_TRIANGLES, 0, 3);
        }

        glDisable(GL_BLEND);

        // --- Pass 2: нормализация в текущий внешний FBO ---
        // Возвращаемся в FBO, который установил Linker (context->get_fbo()).
        glBindFramebuffer(GL_FRAMEBUFFER, m_context->get_fbo());
        glViewport(0, 0, m_rotate_ccw ? m_canvas_h : m_canvas_w, m_rotate_ccw ? m_canvas_w : m_canvas_h);

        m_normalize.use();
        const GLint u_accum = glGetUniformLocation(m_normalize.get_id(), "u_accum");
        const GLint u_rotate = glGetUniformLocation(m_normalize.get_id(), "u_rotate_ccw");
        glUniform1i(u_accum, 0);
        glUniform1i(u_rotate, m_rotate_ccw ? 1 : 0);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, m_accum_tex);

        glDrawArrays(GL_TRIANGLES, 0, 3);

        GLenum err = glGetError();
        if (err != GL_NO_ERROR && m_logger) {
            m_logger->error("UStitchRenderer::render(): GL error 0x" + std::to_string(err));
        }
    }

    void UStitchRenderer::destroy_resources() {
        for (auto& [k, c] : m_cams) {
            if (c.remap)  glDeleteTextures(1, &c.remap);
            if (c.weight) glDeleteTextures(1, &c.weight);
        }
        m_cams.clear();
        m_ordered_keys.clear();

        if (m_accum_tex) { glDeleteTextures(1, &m_accum_tex); m_accum_tex = 0; }
        if (m_accum_fbo) { glDeleteFramebuffers(1, &m_accum_fbo); m_accum_fbo = 0; }
        m_canvas_w = m_canvas_h = 0;
    }

} // namespace birdview
} // namespace varan