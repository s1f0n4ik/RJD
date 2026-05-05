#pragma once
#include <string>
#include <EGL/egl.h>

namespace varan {
namespace birdview {
	
	enum class EBirdCameraType {
		FRONT = 0,
		RIGHT_FRONT = 1,
		RIGHT_BACK = 2,
		BACK = 3,
		LEFT_BACK = 4,
		LEFT_FRONT = 5,
		COUNT = 6
	};

	inline int from_bird_camera_type_to_index(EBirdCameraType camera) {
		return static_cast<int>(camera);
	}

	inline bool from_int_to_bird_camera_type(int idx, EBirdCameraType& out) {
		if (idx < 0 || idx >= static_cast<int>(EBirdCameraType::COUNT))
			return false;

		out = static_cast<EBirdCameraType>(idx);
		return true;
	}

	inline std::string from_bird_camera_type_to_string(EBirdCameraType type)
	{
		static const char* names[] = {
			"FRONT",
			"RIGHT_FRONT",
			"RIGHT_BACK",
			"BACK",
			"LEFT_BACK",
			"LEFT_FRONT"
		};

		int idx = static_cast<int>(type);
		if (idx >= 0 && idx < static_cast<int>(EBirdCameraType::COUNT)) {
			return names[idx];
		}

		return "UNKNOWN";
	}

	enum class EBirdViewStitchingMode {
		SIX_CAMERAS = 0,
		FOUR_CAMERAS = 1,
		COUNT = 2,
	};

	inline const char* eglErrorString(EGLint error)
	{
		switch (error) {
			case 0x3000: return "EGL_SUCCESS";
			case 0x3001: return "EGL_NOT_INITIALIZED";
			case 0x3002: return "EGL_BAD_ACCESS";
			case 0x3003: return "EGL_BAD_ALLOC";
			case 0x3004: return "EGL_BAD_ATTRIBUTE";
			case 0x3005: return "EGL_BAD_CONFIG";
			case 0x3006: return "EGL_BAD_CONTEXT";
			case 0x3007: return "EGL_BAD_CURRENT_SURFACE";
			case 0x3008: return "EGL_BAD_DISPLAY";
			case 0x3009: return "EGL_BAD_SURFACE";
			case 0x300A: return "EGL_BAD_MATCH";
			case 0x300B: return "EGL_BAD_PARAMETER";
			case 0x300C: return "EGL_BAD_NATIVE_PIXMAP";
			case 0x300D: return "EGL_BAD_NATIVE_WINDOW";
			case 0x300E: return "EGL_CONTEXT_LOST";
			default: return "Unknown EGL error";
		}
	}

	inline const char* glErrorString(GLenum error)
	{
		switch (error) {
			case GL_NO_ERROR: return "GL_NO_ERROR";
			case GL_INVALID_ENUM: return "GL_INVALID_ENUM";
			case GL_INVALID_VALUE: return "GL_INVALID_VALUE";
			case GL_INVALID_OPERATION: return "GL_INVALID_OPERATION";
			case GL_OUT_OF_MEMORY: return "GL_OUT_OF_MEMORY";
			case GL_INVALID_FRAMEBUFFER_OPERATION: return "GL_INVALID_FRAMEBUFFER_OPERATION";
			default: return "Unknown GL error";
		}
	}

} // birdview
} // varan