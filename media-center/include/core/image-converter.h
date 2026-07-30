#pragma once
#include <optional>

#include <opencv2/opencv.hpp>

#include "utility/frames.h"
#include "bird-view/egl-context.h"
#include "bird-view/shader.h"
#include "logger.h"

namespace varan {

	class UImageConverter {
	public:
		UImageConverter() = default;

		// with_remap: вместо прямой конвертации NV12 сэмплирование по undist-картам
		bool init(ULogger* logger, bool with_remap = false);

		// Карты CV_32FC1 в пикселях источника; требуют текущего GL-контекста
		bool set_maps(const cv::Mat& map_x, const cv::Mat& map_y, ULogger* logger);

		bool create_fbo(int width, int height, ULogger* logger);

		void destroy_fbo();

		bool render(USharedGLTextureWrapper* frame, ULogger* logger);

		bool bind_fbo();

		void unbind_fbo();

	private:
		void create_plane();

		GLuint upload_map(const cv::Mat& map);

	private:
		GLuint m_vbo;
		GLuint m_vao;

		GLuint m_framebuffer = 0;
		GLuint m_color_texture = 0;

		bool m_with_remap = false;
		GLuint m_map_x_texture = 0;
		GLuint m_map_y_texture = 0;
		int m_map_width = 0;
		int m_map_height = 0;

		int m_width;
		int m_height;

		birdview::UShader m_shader;
	};

} // varan
