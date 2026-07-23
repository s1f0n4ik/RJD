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
		/*
			Поворот вывода против часовой стрелки, в четвертях оборота: 0..3.
			При 1 и 3 стороны вывода меняются местами, поэтому размер кадра
			зависит от него — и пайплайн приходится пересобирать.
		*/
		void set_rotation(int quarters) { m_rotation = ((quarters % 4) + 4) % 4; }
		int  rotation() const { return m_rotation; }

		// Естественный размер вывода: канвас с учётом поворота
		int rotated_width()  const { return (m_rotation % 2) ? m_canvas_h : m_canvas_w; }
		int rotated_height() const { return (m_rotation % 2) ? m_canvas_w : m_canvas_h; }

		/*
			Фактический размер кадра. Бывает больше естественного: кодек
			требует выровненных сторон, и картинка на эту разницу тянется.
			Вызывать после set_rotation — иначе стороны возьмутся от старого
			поворота.
		*/
		void set_output_size(int width, int height) { m_out_w = width; m_out_h = height; }

		int output_width()  const { return m_out_w > 0 ? m_out_w : rotated_width(); }
		int output_height() const { return m_out_h > 0 ? m_out_h : rotated_height(); }

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
		int m_rotation = 0;
		// 0 — размер вывода не задавали, берём естественный
		int m_out_w = 0;
		int m_out_h = 0;

		// Порядок камер из экспорта — фиксируется после load_export.
		std::vector<std::string> m_ordered_keys;
		std::unordered_map<std::string, FCameraGL> m_cams;
		std::vector<FOverlayImage> m_overlays;

		UEGLContextManager* m_context = nullptr;
		ULogger* m_logger = nullptr;
	};

} // birdview
} // varan
