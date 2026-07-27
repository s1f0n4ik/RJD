#pragma once

#include <filesystem>
#include <optional>

#include <opencv2/core.hpp>
#include <glm.hpp>

#include "utility/frames.h"
#include "egl-context.h"
#include "shader.h"
#include "bird-view/photometric.h"
#include "bird-view/surround-model.h"

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
		~UStitchRenderer() override;

		bool init(int textures_count, UEGLContextManager* context, ULogger* logger = nullptr) override;
		void update(float dt) override;
		void update_textures(std::vector<NPFrame>& frames, EGLDisplay display = nullptr) override;
		void render(float aspect) override;

		void render_overlays();

		// Загрузка экспорта из JSON-индекса; карты берутся из активной версии
		bool load_export(const std::filesystem::path& exports_root,
			const std::filesystem::path& index_json,
			const std::string& export_id);

		// Перезаливка weight-текстур из каталога загруженной версии:
		// коммит слайдера шва перепёк файлы, кадр подхватывает их без рестарта
		bool reload_weights();

		// Фотонормализация: пары точек шва, построенные из карт при старте
		void set_photometric_pairs(const std::vector<FPhotoPair>& pairs);
		void set_photometric_enabled(bool on) { m_photo.set_enabled(on); }

		/*
			Сцена поверх сшивки: подложка и модель ортографически сверху
			в зоне габарита. Без вызова set_scene ничего не рисуется - v1
			ведёт себя ровно как раньше.
		*/
		void set_scene(const cv::Rect2f& machine_rect_px,
			float machine_w_m, float machine_h_m, float machine_l_m,
			float px_per_m);
		void set_model(float width, float height, float length, float alpha);
		void set_model_rotation(float degrees) { m_model_rot = degrees; }
		bool set_model_mesh(const FSurroundModel& model);
		void clear_model_mesh();
		void set_plate(bool visible) { m_plate_visible = visible; }
		void set_plate_size(float width_m, float length_m);

		// Вписывание канваса в кадр с чёрными полями вместо растяжения;
		// включается при пользовательском разрешении top
		void set_fit_output(bool on) { m_fit_output = on; }

		// Пользовательская правка рисунка: показ и размер в пикселях канваса
		struct FOverlayOverride {
			bool visible = true;
			// 0 - исходный размер из экспорта
			int width = 0;
			int height = 0;
		};

		// Правки по имени файла; растяжение от центра исходного ректа.
		// Рисунки без правок возвращаются к исходному виду
		void set_overlay_overrides(
			const std::unordered_map<std::string, FOverlayOverride>& overrides);

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
			std::string name;
			// Действующая рамка отрисовки
			int x = 0, y = 0;
			int width = 0, height = 0;
			// Исходный рект из экспорта: база для правок размера
			int base_x = 0, base_y = 0;
			int base_w = 0, base_h = 0;
			bool visible = true;
		};

		void destroy_resources();
		bool init_accum_fbo();

		// Вписанный в кадр прямоугольник контента; без вписывания - весь кадр
		void output_box(int& x, int& y, int& w, int& h) const;

		// Подложка и модель в накопитель с глубиной, после проходов камер
		void draw_scene();
		bool ensure_scene_shader();

	private:
		UShader m_stitch;
		UShader m_normalize;
		UShader m_overlay_shader;

		GLuint m_accum_fbo = 0;
		GLuint m_accum_tex = 0;  // RGBA16F: accum.rgb + sum.weight в alpha
		// Глубина докладывается к накопителю при первой отрисовке сцены
		GLuint m_accum_depth = 0;

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

		// Каталог карт загруженной версии, оттуда перезаливаются веса
		std::filesystem::path m_maps_dir;

		// Общий конвейер фотонормализации; усиления уходят в u_gain сшивки
		UPhotometric m_photo;

		// Сцена: габарит в пикселях канваса, метры мира и их масштаб
		bool m_scene_set = false;
		cv::Rect2f m_machine_rect;
		float m_machine_w = 0.0f;
		float m_machine_h = 0.0f;
		float m_machine_l = 0.0f;
		float m_px_per_m = 0.0f;

		float m_model_w = 0.0f;
		float m_model_h = 0.0f;
		float m_model_l = 0.0f;
		float m_model_alpha = 1.0f;
		float m_model_rot = 0.0f;
		bool m_plate_visible = true;
		// Свои размеры подложки в метрах; 0 - габарит с запасом
		float m_plate_w_m = 0.0f;
		float m_plate_l_m = 0.0f;

		bool m_fit_output = false;

		// Шейдер surround-сцены: габарит и текстурированная модель
		UShader m_scene_shader;
		bool m_scene_shader_ok = false;

		// Единичный куб: подложка и бокс-заглушка модели через u_model
		GLuint m_cube_vao = 0;
		GLuint m_cube_vbo = 0;
		GLsizei m_cube_vertices = 0;

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

		UEGLContextManager* m_context = nullptr;
		ULogger* m_logger = nullptr;
	};

} // birdview
} // varan
