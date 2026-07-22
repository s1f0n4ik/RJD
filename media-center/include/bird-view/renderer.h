#pragma once

#include <optional>

#include "utility/frames.h"
#include "egl-context.h"
#include "shader.h"

#include <GLES3/gl3.h>

namespace varan {
namespace birdview {

    class IRenderer
    {
    public:
        virtual ~IRenderer() = default;

        // Инициализация
        virtual bool init(int textures_count, UEGLContextManager* context, ULogger* logger = nullptr) = 0;

        // обновление состояния
        virtual void update(float dt) = 0;

        // Обновление изображений с камер
        virtual void update_textures(std::vector<NPFrame>& frames, EGLDisplay display = nullptr) = 0;

        // отрисовка
        virtual void render(float aspect) = 0;
    };

    class UCubeRenderer : public IRenderer
    {
    public:

        bool init(int textures_count, UEGLContextManager* context, ULogger* logger = nullptr) override;
        void update(float dt) override;
        void update_textures(std::vector<NPFrame>& frames, EGLDisplay display = nullptr) override;
        void render(float aspect) override;

    private:
        void create_cube();

    private:
        UShader m_shader;

        GLuint m_vao = 0;
        GLuint m_vbo = 0;

        float m_angle = 0.0f;

        std::vector<SPGLTextureWrapper> m_gl_images;

        ULogger* m_logger;
    };

	class UStitchRenderer : public IRenderer {
	public:
		bool init(int textures_count, UEGLContextManager* context, ULogger* logger = nullptr) override;
		void update(float dt) override;
		void update_textures(std::vector<NPFrame>& frames, EGLDisplay display = nullptr) override;
		void render(float aspect) override;

		void render_overlays();

		// Загрузка экспорта из JSON-индекса.
		bool load_export(const std::filesystem::path& exports_root,
			const std::filesystem::path& index_json,
			const std::string& export_id);

		// Порядок камер, в котором update_textures ожидает фреймы.
		const std::vector<std::string>& ordered_camera_keys() const { return m_ordered_keys; }

		// Размер канваса экспорта.
		int canvas_width()  const { return m_canvas_w; }
		int canvas_height() const { return m_canvas_h; }
		void set_rotate_ccw(bool v) { m_rotate_ccw = v; }

	private:
		struct FCameraGL {
			GLuint remap = 0;
			GLuint weight = 0;
			// Текстуры NV12 берутся из NPFrame в update_textures.
			GLuint plane_y_id = 0;
			GLuint plane_uv_id = 0;
			GLenum plane_y_tg = GL_TEXTURE_2D;
			GLenum plane_uv_tg = GL_TEXTURE_2D;
			bool   has_frame = false;
		};

		struct FOverlayImage {
			GLuint texture = 0;
			int x = 0, y = 0;
			int width = 0, height = 0;
		};

		void destroy_resources();
		bool init_accum_fbo();


	private:
		UShader m_stitch;
		UShader m_normalize;
		UShader m_overlay_shader;

		GLuint m_accum_fbo = 0;
		GLuint m_accum_tex = 0;  // RGBA16F: accum.rgb + sum.weight в alpha

		int m_canvas_w = 0;
		int m_canvas_h = 0;
		bool m_rotate_ccw = false;

		// Порядок камер из экспорта — фиксируется после load_export.
		std::vector<std::string> m_ordered_keys;
		std::unordered_map<std::string, FCameraGL> m_cams;
		std::vector<FOverlayImage> m_overlays;

		UEGLContextManager* m_context = nullptr;
		ULogger* m_logger = nullptr;
	};

} // birdview
} // varan
