#include "bird-view/renderer.h"
#include "bird-view/constants.h"
#include "bird-view/utility.h"
#include "bird-view/top-bake.h"

#include "utility/gl-maps.h"

#include "calibration/json-projection.h"
#include "calibration/constants.h"

#include <opencv2/opencv.hpp>
#include <gtc/matrix_transform.hpp>
#include <gtc/type_ptr.hpp>

#include <boost/json.hpp>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <limits>
#include <sstream>

namespace varan {
namespace birdview {

    UStitchRenderer::~UStitchRenderer() {
        // Пробник и воркер фотонормализации гасятся до GL-ресурсов
        m_photo.reset();
        destroy_resources();
        clear_model_mesh();
        if (m_cube_vbo) { glDeleteBuffers(1, &m_cube_vbo); m_cube_vbo = 0; }
        if (m_cube_vao) { glDeleteVertexArrays(1, &m_cube_vao); m_cube_vao = 0; }
    }

    bool UStitchRenderer::init(int textures_count, UEGLContextManager* context, ULogger* logger) {
        m_context = context;
        m_logger = logger;

        if (!context || !context->is_initialized()) {
            if (m_logger) m_logger->error("UStitchRenderer::init(): bad context");
            return false;
        }

        // Загрузка шейдеров из статических путей
        auto vsh = constants::current_shader_path(constants::stitching_vsh);
        auto fs1 = constants::current_shader_path(constants::stitching_fsh);
        auto fs2 = constants::current_shader_path(constants::normalize_fsh);

        auto overlay_vert = constants::current_shader_path(constants::overlay_vsh);
        auto overlay_frag = constants::current_shader_path(constants::overlay_fsh);

        if (!m_stitch.load_from_files(vsh, fs1, m_logger)) return false;
        if (!m_normalize.load_from_files(vsh, fs2, m_logger)) return false;
        if (!m_overlay_shader.load_from_files(vsh, overlay_frag, m_logger)) return false;

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

        /*
            2) Текстуры remap/weight активной версии. Имена файлов канонические
            <ключ>_remap.bin: у легаси v1 они лежат прямо в каталоге экспорта,
            и записанные в неё пути совпадают с каноном.
        */
        const std::string version_key = top_active_version(obj);
        m_maps_dir = top_version_dir(exports_root, export_id, version_key);
        if (m_logger) m_logger->info("load_export(): version <" + version_key + ">");

        for (const auto& [key, cam_v] : cams_v->as_object()) {
            if (!cam_v.is_object()) continue;
            std::string cam_key(key);

            int rw = 0, rh = 0;
            GLuint remap_tex = gl_maps::load_gl_map(
                m_maps_dir / (cam_key + "_remap.bin"), rw, rh, m_logger);
            if (!remap_tex) continue;

            int ww = 0, wh = 0;
            GLuint weight_tex = gl_maps::load_gl_map(
                m_maps_dir / (cam_key + "_weight.bin"), ww, wh, m_logger);
            if (!weight_tex) {
                glDeleteTextures(1, &remap_tex);
                continue;
            }

            FCameraGL c{};
            c.remap = remap_tex;
            c.weight = weight_tex;
            m_cams.emplace(cam_key, c);
            m_ordered_keys.push_back(std::move(cam_key));
        }

        // 3) Загрузка изображений для отображения на склейке
        if (obj.contains(calibration::constants::PROJ_IMAGES)) {
            try {
                auto images = calibration::UJsonProjectionConfiguration::parse_images(obj, m_logger);
                for (const auto& image : images) {
                    if (!std::filesystem::exists(image.path)) {
                        if (m_logger) m_logger->warn("load_export(): path of overlay image " + image.path.string() + " doesn't exists!");
                        continue;
                    }
                    // Загрузка изображений
                    cv::Mat img = cv::imread(image.path.string(), cv::IMREAD_UNCHANGED);
                    if (img.empty()) {
                        if (m_logger) m_logger->warn("load_export(): cannot read image: " + image.path.string());
                        continue;
                    }

                    cv::Mat rgba;
                    if (img.channels() == 4) {
                        cv::cvtColor(img, rgba, cv::COLOR_BGRA2RGBA);
                    }
                    else if (img.channels() == 3) {
                        cv::cvtColor(img, rgba, cv::COLOR_BGR2RGBA);
                    }
                    else if (img.channels() == 1) {
                        cv::cvtColor(img, rgba, cv::COLOR_GRAY2RGBA);
                    }
                    else {
                        continue;
                    }

                    if (rgba.cols != image.rect.width || rgba.rows != image.rect.height) {
                        cv::resize(rgba, rgba, cv::Size(image.rect.width, image.rect.height), 0, 0, cv::INTER_LINEAR);
                    }

                    GLuint tex = 0;
                    glGenTextures(1, &tex);
                    glBindTexture(GL_TEXTURE_2D, tex);
                    //glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
                    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, rgba.cols, rgba.rows, 0, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data);
                    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
                    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
                    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

                    FOverlayImage overlay;
                    overlay.texture = tex;
                    overlay.name = image.name;
                    overlay.x = image.rect.x;
                    overlay.y = image.rect.y;
                    overlay.width = image.rect.width;
                    overlay.height = image.rect.height;
                    overlay.base_x = image.rect.x;
                    overlay.base_y = image.rect.y;
                    overlay.base_w = image.rect.width;
                    overlay.base_h = image.rect.height;
                    m_overlays.push_back(overlay);

                    if (m_logger) m_logger->info("load_export(): loaded overlay " + image.name +
                        " at [" + std::to_string(image.rect.x) + "," + std::to_string(image.rect.y) +
                        "," + std::to_string(image.rect.width) + "," + std::to_string(image.rect.height) + "]");
                }
            }
            catch (const std::exception& error) {
                if (m_logger) m_logger->error("Error: " + std::string(error.what()));
            }
        }
        else {
            if (m_logger) m_logger->warn("load_export(): no one image contains at stitching export!");
        }


        if (m_cams.empty()) {
            if (m_logger) m_logger->error("load_export(): no cameras loaded");
            return false;
        }

        if (!init_accum_fbo()) return false;

        if (m_logger) m_logger->info("load_export(): loaded <" + export_id + "> with " + std::to_string(m_cams.size()) + " cameras");
        return true;
    }

    bool UStitchRenderer::reload_weights() {
        bool ok = true;
        for (const auto& key : m_ordered_keys) {
            int ww = 0, wh = 0;
            GLuint weight_tex = gl_maps::load_gl_map(
                m_maps_dir / (key + "_weight.bin"), ww, wh, m_logger);
            if (!weight_tex) {
                ok = false;
                continue;
            }
            auto& c = m_cams[key];
            if (c.weight) glDeleteTextures(1, &c.weight);
            c.weight = weight_tex;
        }
        if (m_logger) m_logger->info("reload_weights(): from " + m_maps_dir.string()
            + (ok ? "" : " with errors"));
        return ok;
    }

    void UStitchRenderer::set_photometric_pairs(const std::vector<FPhotoPair>& pairs) {
        m_photo.setup(static_cast<int>(m_ordered_keys.size()), pairs, m_logger);
    }

    void UStitchRenderer::set_overlay_overrides(
        const std::unordered_map<std::string, FOverlayOverride>& overrides)
    {
        for (auto& ov : m_overlays) {
            FOverlayOverride o;
            if (auto it = overrides.find(ov.name); it != overrides.end()) o = it->second;

            ov.visible = o.visible;
            const int w = o.width > 0 ? o.width : ov.base_w;
            const int h = o.height > 0 ? o.height : ov.base_h;
            // Растяжение от центра исходного ректа: узор остаётся на месте
            ov.x = ov.base_x + (ov.base_w - w) / 2;
            ov.y = ov.base_y + (ov.base_h - h) / 2;
            ov.width = w;
            ov.height = h;
        }
    }

    void UStitchRenderer::set_scene(const cv::Rect2f& machine_rect_px,
        float machine_w_m, float machine_h_m, float machine_l_m, float px_per_m)
    {
        if (machine_rect_px.width <= 0 || machine_rect_px.height <= 0 || px_per_m <= 0) {
            m_scene_set = false;
            return;
        }
        m_machine_rect = machine_rect_px;
        m_machine_w = machine_w_m;
        m_machine_h = machine_h_m;
        m_machine_l = machine_l_m;
        m_px_per_m = px_per_m;
        m_scene_set = true;
    }

    void UStitchRenderer::set_model(float width, float height, float length, float alpha) {
        m_model_w = width;
        m_model_h = height;
        m_model_l = length;
        m_model_alpha = alpha;
    }

    void UStitchRenderer::set_plate_size(float width_m, float length_m) {
        m_plate_w_m = width_m > 0 ? width_m : 0.0f;
        m_plate_l_m = length_m > 0 ? length_m : 0.0f;
    }

    bool UStitchRenderer::set_model_mesh(const FSurroundModel& model) {
        clear_model_mesh();
        if (model.vertices.empty()) return false;

        glGenVertexArrays(1, &m_model_vao);
        glGenBuffers(1, &m_model_vbo);
        glBindVertexArray(m_model_vao);
        glBindBuffer(GL_ARRAY_BUFFER, m_model_vbo);
        glBufferData(GL_ARRAY_BUFFER, model.vertices.size() * sizeof(float),
            model.vertices.data(), GL_STATIC_DRAW);
        const GLsizei stride = SURROUND_MODEL_STRIDE * sizeof(float);
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, stride, (void*)0);
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, stride, (void*)(3 * sizeof(float)));
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

    void UStitchRenderer::clear_model_mesh() {
        if (!m_model_textures.empty()) {
            glDeleteTextures(static_cast<GLsizei>(m_model_textures.size()), m_model_textures.data());
            m_model_textures.clear();
        }
        if (m_model_vbo) { glDeleteBuffers(1, &m_model_vbo); m_model_vbo = 0; }
        if (m_model_vao) { glDeleteVertexArrays(1, &m_model_vao); m_model_vao = 0; }
        m_model_draws.clear();
        m_model_present = false;
    }

    bool UStitchRenderer::ensure_scene_shader() {
        if (m_scene_shader_ok) return true;

        // Шейдер surround-сцены: те же режимы габарита и модели
        auto vsh = constants::current_shader_path(constants::surround_vsh);
        auto fsh = constants::current_shader_path(constants::surround_fsh);
        if (!m_scene_shader.load_from_files(vsh, fsh, m_logger)) {
            if (m_logger) m_logger->error("ensure_scene_shader(): scene shaders didn't load!");
            return false;
        }

        // Единичный куб [-0.5..0.5] с нормалями: подложка и бокс-заглушка
        const float h = 0.5f;
        std::vector<float> verts;
        verts.reserve(36 * 6);
        auto quad = [&](glm::vec3 a, glm::vec3 b, glm::vec3 c, glm::vec3 d, glm::vec3 n) {
            const glm::vec3 pts[6] = { a, b, c, a, c, d };
            for (const auto& p : pts) {
                verts.push_back(p.x); verts.push_back(p.y); verts.push_back(p.z);
                verts.push_back(n.x); verts.push_back(n.y); verts.push_back(n.z);
            }
        };
        quad({ -h,-h, h }, { h,-h, h }, { h, h, h }, { -h, h, h }, { 0,0,1 });
        quad({ h,-h,-h }, { -h,-h,-h }, { -h, h,-h }, { h, h,-h }, { 0,0,-1 });
        quad({ h,-h, h }, { h,-h,-h }, { h, h,-h }, { h, h, h }, { 1,0,0 });
        quad({ -h,-h,-h }, { -h,-h, h }, { -h, h, h }, { -h, h,-h }, { -1,0,0 });
        quad({ -h, h, h }, { h, h, h }, { h, h,-h }, { -h, h,-h }, { 0,1,0 });
        quad({ -h,-h,-h }, { h,-h,-h }, { h,-h, h }, { -h,-h, h }, { 0,-1,0 });

        glGenVertexArrays(1, &m_cube_vao);
        glGenBuffers(1, &m_cube_vbo);
        glBindVertexArray(m_cube_vao);
        glBindBuffer(GL_ARRAY_BUFFER, m_cube_vbo);
        glBufferData(GL_ARRAY_BUFFER, verts.size() * sizeof(float), verts.data(), GL_STATIC_DRAW);
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 6 * sizeof(float), (void*)0);
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, 6 * sizeof(float), (void*)(3 * sizeof(float)));
        glBindVertexArray(0);
        m_cube_vertices = static_cast<GLsizei>(verts.size() / 6);

        m_scene_shader_ok = true;
        return true;
    }

    void UStitchRenderer::draw_scene() {
        if (!m_scene_set || !ensure_scene_shader()) return;
        if (m_model_alpha <= 0.01f && !m_plate_visible) return;

        // Глубина докладывается к накопителю при первой сцене
        if (!m_accum_depth) {
            glGenRenderbuffers(1, &m_accum_depth);
            glBindRenderbuffer(GL_RENDERBUFFER, m_accum_depth);
            glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, m_canvas_w, m_canvas_h);
            glBindRenderbuffer(GL_RENDERBUFFER, 0);
            glBindFramebuffer(GL_FRAMEBUFFER, m_accum_fbo);
            glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT,
                GL_RENDERBUFFER, m_accum_depth);
        }

        glBindFramebuffer(GL_FRAMEBUFFER, m_accum_fbo);
        glViewport(0, 0, m_canvas_w, m_canvas_h);
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(GL_LESS);
        glDepthMask(GL_TRUE);
        glClear(GL_DEPTH_BUFFER_BIT);

        /*
            Орто сверху: мировые метры в пиксели канваса через масштаб мата,
            вертикаль мира уходит в глубину. Начало - центр зоны габарита.
        */
        const float ppm = m_px_per_m;
        const float cx = m_machine_rect.x + m_machine_rect.width * 0.5f;
        const float cy = m_machine_rect.y + m_machine_rect.height * 0.5f;
        const float z_range = std::max({ m_machine_h, m_model_h, 3.0f }) * 2.0f;

        glm::mat4 mvp(0.0f);
        mvp[0][0] = 2.0f * ppm / static_cast<float>(m_canvas_w);
        mvp[2][1] = 2.0f * ppm / static_cast<float>(m_canvas_h);
        mvp[1][2] = -1.0f / z_range;
        mvp[3][0] = 2.0f * cx / static_cast<float>(m_canvas_w) - 1.0f;
        mvp[3][1] = 2.0f * cy / static_cast<float>(m_canvas_h) - 1.0f;
        mvp[3][3] = 1.0f;

        m_scene_shader.use();
        const GLuint prog = m_scene_shader.get_id();
        glUniformMatrix4fv(glGetUniformLocation(prog, "u_mvp"), 1, GL_FALSE, glm::value_ptr(mvp));
        const GLint u_mode = glGetUniformLocation(prog, "u_mode");
        const GLint u_color = glGetUniformLocation(prog, "u_color");
        const GLint u_alpha = glGetUniformLocation(prog, "u_alpha");
        const GLint u_model = glGetUniformLocation(prog, "u_model");
        const GLint u_model_tex = glGetUniformLocation(prog, "u_model_tex");

        const glm::mat4 identity(1.0f);
        glUniform1f(u_alpha, 1.0f);
        glUniform1i(u_mode, 1);

        // Подложка: цвет мата surround, чуть ниже нуля - модель поверх
        if (m_plate_visible) {
            const float pw = m_plate_w_m > 0 ? m_plate_w_m : m_machine_w * 1.5f;
            const float pl = m_plate_l_m > 0 ? m_plate_l_m : m_machine_l * 1.5f;
            glm::mat4 plate = glm::translate(identity, glm::vec3(0.0f, -0.02f, 0.0f))
                * glm::scale(identity, glm::vec3(pw, 0.02f, pl));
            glUniformMatrix4fv(u_model, 1, GL_FALSE, glm::value_ptr(plate));
            glUniform3f(u_color, 0.09f, 0.10f, 0.12f);
            glBindVertexArray(m_cube_vao);
            glDrawArrays(GL_TRIANGLES, 0, m_cube_vertices);
        }

        if (m_model_alpha > 0.01f) {
            // Один кусок отрисовки на оба прохода призрака: меш или бокс
            auto draw_model = [&]() {
                if (m_model_present) {
                    // Вписывание: uniform-масштаб в габарит или свои размеры
                    const glm::vec3 size = m_model_bbox_max - m_model_bbox_min;
                    const glm::vec3 center = (m_model_bbox_max + m_model_bbox_min) * 0.5f;
                    const float tw = m_model_w > 0 ? m_model_w : m_machine_w;
                    const float th = m_model_h > 0 ? m_model_h : m_machine_h;
                    const float tl = m_model_l > 0 ? m_model_l : m_machine_l;
                    float s = std::numeric_limits<float>::max();
                    if (size.x > 1e-6f && tw > 0) s = std::min(s, tw / size.x);
                    if (size.y > 1e-6f && th > 0) s = std::min(s, th / size.y);
                    if (size.z > 1e-6f && tl > 0) s = std::min(s, tl / size.z);
                    if (s == std::numeric_limits<float>::max()) s = 1.0f;
                    const glm::mat4 model_mat =
                        glm::rotate(identity, glm::radians(m_model_rot), glm::vec3(0, 1, 0))
                        * glm::scale(identity, glm::vec3(s))
                        * glm::translate(identity,
                            glm::vec3(-center.x, -m_model_bbox_min.y, -center.z));
                    glUniformMatrix4fv(u_model, 1, GL_FALSE, glm::value_ptr(model_mat));

                    glBindVertexArray(m_model_vao);
                    for (const auto& d : m_model_draws) {
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
                        glDrawArrays(GL_TRIANGLES, d.first, d.count);
                    }
                    glActiveTexture(GL_TEXTURE0);
                }
                else {
                    // Без .glb рисуется бокс габарита, как в surround
                    const float bw = m_model_w > 0 ? m_model_w : m_machine_w;
                    const float bh = m_model_h > 0 ? m_model_h : m_machine_h;
                    const float bl = m_model_l > 0 ? m_model_l : m_machine_l;
                    const glm::mat4 box =
                        glm::rotate(identity, glm::radians(m_model_rot), glm::vec3(0, 1, 0))
                        * glm::translate(identity, glm::vec3(0.0f, bh * 0.5f, 0.0f))
                        * glm::scale(identity, glm::vec3(bw, bh, bl));
                    glUniformMatrix4fv(u_model, 1, GL_FALSE, glm::value_ptr(box));
                    glUniform1i(u_mode, 1);
                    glUniform3f(u_color, 0.62f, 0.16f, 0.14f);
                    glUniform1f(u_alpha, m_model_alpha);
                    glBindVertexArray(m_cube_vao);
                    glDrawArrays(GL_TRIANGLES, 0, m_cube_vertices);
                }
            };

            if (m_model_alpha < 0.99f) {
                /*
                    Призрак одной поверхностью: сперва глубина модели без
                    цвета, затем цвет строго по ней (GL_EQUAL). Один проход
                    с блендингом рисовал грани в порядке буфера, и задние
                    ложились поверх передних - перед модели пропадал.
                */
                glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
                draw_model();
                glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);

                glDepthFunc(GL_EQUAL);
                glDepthMask(GL_FALSE);
                glEnable(GL_BLEND);
                // Полупрозрачная модель поверх сшивки: честная альфа в накопителе
                glBlendFuncSeparate(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA,
                    GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
                glBlendEquation(GL_FUNC_ADD);
                draw_model();
                glDisable(GL_BLEND);
                glDepthMask(GL_TRUE);
                glDepthFunc(GL_LESS);
            }
            else {
                draw_model();
            }
        }

        glBindVertexArray(0);
        glDisable(GL_DEPTH_TEST);
    }

    void UStitchRenderer::output_box(int& x, int& y, int& w, int& h) const {
        const int out_w = output_width();
        const int out_h = output_height();
        x = 0; y = 0; w = out_w; h = out_h;
        if (!m_fit_output) return;

        const int nat_w = rotated_width();
        const int nat_h = rotated_height();
        if (nat_w <= 0 || nat_h <= 0) return;

        const float scale = std::min(
            static_cast<float>(out_w) / nat_w,
            static_cast<float>(out_h) / nat_h);
        w = std::max(1, static_cast<int>(std::lround(nat_w * scale)));
        h = std::max(1, static_cast<int>(std::lround(nat_h * scale)));
        x = (out_w - w) / 2;
        y = (out_h - h) / 2;
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

    void UStitchRenderer::render(float /*aspect*/) {
        if (!m_accum_fbo) return;

        // Пробник фотонормализации до основных проходов, как в surround
        {
            std::vector<FPhotoPlanes> planes;
            planes.reserve(m_ordered_keys.size());
            for (const auto& key : m_ordered_keys) {
                const auto& c = m_cams[key];
                FPhotoPlanes p;
                p.plane_y_id = c.plane_y_id;
                p.plane_uv_id = c.plane_uv_id;
                p.plane_y_tg = c.plane_y_tg;
                p.plane_uv_tg = c.plane_uv_tg;
                p.has_frame = c.has_frame;
                planes.push_back(p);
            }
            m_photo.probe_step(planes);
        }

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
        const GLint u_gain = glGetUniformLocation(m_stitch.get_id(), "u_gain");

        glUniform1i(u_remap, 0);
        glUniform1i(u_weight, 1);
        glUniform1i(u_plane_y, 2);
        glUniform1i(u_plane_uv, 3);

        for (size_t i = 0; i < m_ordered_keys.size(); ++i) {
            auto& c = m_cams[m_ordered_keys[i]];

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

            const glm::vec3 g = m_photo.gain(i);
            glUniform3f(u_gain, g.r, g.g, g.b);

            glDrawArrays(GL_TRIANGLES, 0, 3);
        }

        glDisable(GL_BLEND);

        // --- Pass 1.5: подложка и модель в накопитель с глубиной ---
        draw_scene();

        // --- Pass 2: нормализация в текущий внешний FBO ---
        // Возвращаемся в FBO, который установил Linker (context->get_fbo()).
        glBindFramebuffer(GL_FRAMEBUFFER, m_context->get_fbo());

        // Вписывание: поля заливаются чёрным, контент рисуется в свой бокс
        int box_x = 0, box_y = 0, box_w = 0, box_h = 0;
        output_box(box_x, box_y, box_w, box_h);
        if (m_fit_output) {
            glViewport(0, 0, output_width(), output_height());
            glClearColor(0, 0, 0, 1);
            glClear(GL_COLOR_BUFFER_BIT);
        }
        glViewport(box_x, box_y, box_w, box_h);

        m_normalize.use();
        const GLint u_accum = glGetUniformLocation(m_normalize.get_id(), "u_accum");
        const GLint u_rotate = glGetUniformLocation(m_normalize.get_id(), "u_rotation");
        glUniform1i(u_accum, 0);
        glUniform1i(u_rotate, m_rotation);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, m_accum_tex);

        glDrawArrays(GL_TRIANGLES, 0, 3);

        // Pass 3: отображение овелеев
        render_overlays();

        GLenum err = glGetError();
        if (err != GL_NO_ERROR && m_logger) {
            m_logger->error("UStitchRenderer::render(): GL error 0x" + std::to_string(err));
        }
    }

    // Функция для рисовения изображений поверх панорамы
    void UStitchRenderer::render_overlays() {
        glEnable(GL_BLEND);
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        glBlendEquation(GL_FUNC_ADD);

        m_overlay_shader.use();
        const GLint u_tex = glGetUniformLocation(m_overlay_shader.get_id(), "u_tex");
        // Положение брали из m_normalize, хотя активен m_overlay_shader:
        // значение уходило по чужому адресу, и подложка не поворачивалась
        const GLint u_rotate = glGetUniformLocation(m_overlay_shader.get_id(), "u_rotation");

        glUniform1i(u_tex, 0);
        glUniform1i(u_rotate, m_rotation);

        /*
            Кадр может отличаться от канваса: добивка до кратности растягивает,
            вписывание в пользовательское разрешение добавляет поля. Рамки
            подложек живут в координатах канваса, поэтому масштабируются и
            смещаются вместе с контентом — иначе подложка съедет.
        */
        int box_x = 0, box_y = 0, box_w = 0, box_h = 0;
        output_box(box_x, box_y, box_w, box_h);
        const int nat_w = rotated_width();
        const int nat_h = rotated_height();
        const float sx = nat_w > 0 ? static_cast<float>(box_w) / nat_w : 1.0f;
        const float sy = nat_h > 0 ? static_cast<float>(box_h) / nat_h : 1.0f;

        for (const auto& ov : m_overlays) {
            if (!ov.texture || !ov.visible) continue;

            /*
                Рамка подложки задана в координатах канваса, а вьюпорт живёт
                в координатах вывода. При 1 и 3 четвертях стороны меняются
                местами, поэтому ширина и высота тоже переставляются.
            */
            float rx = ov.x, ry = ov.y, rw = ov.width, rh = ov.height;

            if (m_rotation == 1) {
                rx = ov.y;
                ry = m_canvas_w - ov.x - ov.width;
                rw = ov.height;
                rh = ov.width;
            }
            else if (m_rotation == 2) {
                rx = m_canvas_w - ov.x - ov.width;
                ry = m_canvas_h - ov.y - ov.height;
            }
            else if (m_rotation == 3) {
                rx = m_canvas_h - ov.y - ov.height;
                ry = ov.x;
                rw = ov.height;
                rh = ov.width;
            }

            glViewport(
                static_cast<GLint>(box_x + std::lround(rx * sx)),
                static_cast<GLint>(box_y + std::lround(ry * sy)),
                static_cast<GLsizei>(std::lround(rw * sx)),
                static_cast<GLsizei>(std::lround(rh * sy))
            );

            glActiveTexture(GL_TEXTURE0);
            glBindTexture(GL_TEXTURE_2D, ov.texture);
            glDrawArrays(GL_TRIANGLES, 0, 6);  // 6 вершин — два треугольника
        }

        glDisable(GL_BLEND);
    }

    void UStitchRenderer::destroy_resources() {
        for (auto& [k, c] : m_cams) {
            if (c.remap)  glDeleteTextures(1, &c.remap);
            if (c.weight) glDeleteTextures(1, &c.weight);
        }
        m_cams.clear();
        m_ordered_keys.clear();

        for (auto& ov : m_overlays) {
            if (ov.texture) glDeleteTextures(1, &ov.texture);
        }
        m_overlays.clear();

        if (m_accum_tex) { glDeleteTextures(1, &m_accum_tex); m_accum_tex = 0; }
        if (m_accum_depth) { glDeleteRenderbuffers(1, &m_accum_depth); m_accum_depth = 0; }
        if (m_accum_fbo) { glDeleteFramebuffers(1, &m_accum_fbo); m_accum_fbo = 0; }
        m_canvas_w = m_canvas_h = 0;
    }

} // namespace birdview
} // namespace varan
