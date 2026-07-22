#pragma once
#include <optional>

#include "utility/frames.h"
#include "bird-view/egl-context.h"
#include "bird-view/shader.h"
#include "logger.h"

namespace varan {

	class UImageConverter {
	public:
		UImageConverter() = default;

		bool init(ULogger* logger); 

		bool create_fbo(int width, int height, ULogger* logger);

		void destroy_fbo();

		bool render(USharedGLTextureWrapper* frame, ULogger* logger);

		bool bind_fbo();

		void unbind_fbo();

	private:
		void create_plane();

	private:
		GLuint m_vbo;
		GLuint m_vao;

		GLuint m_framebuffer = 0;
		GLuint m_color_texture = 0;

		int m_width;
		int m_height;

		birdview::UShader m_shader;
	};

} // varan
