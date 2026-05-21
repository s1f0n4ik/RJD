#pragma once

#include <cstdint>
#include <fstream>
#include <filesystem>
#include <stdexcept>
#include <cstdint>

#include <opencv2/core.hpp>
#include <GLES3/gl3.h>

namespace varan {
namespace gl_maps {

	/*
		Бинарный формат для карт, читаемых напрямую в OpenGL-текстуру.

		Header (24 байта):
			magic:    4   "VRMP" (remap, 2 канала float)
							"VWGT" (weight, 1 канал uint8)
			version:  u32 = 1
			width:    u32
			height:   u32
			channels: u32 (2 для remap, 1 для weight)
			dtype:    u32 (0 = float32, 1 = uint8)
			reserved: u32 = 0

		Дальше — plain row-major blob: width * height * channels * sizeof(dtype).

		Координаты в remap нормализованы в [0..1] относительно ИСХОДНОГО raw-кадра.
		Используется так:
			vec2 uv = texture(remap, gl_FragCoord.xy / canvas_size).rg;
			vec4 px = texture(raw_camera, uv);
	*/

	constexpr uint32_t MAGIC_REMAP = 0x504D5256u;  // "VRMP" little-endian
	constexpr uint32_t MAGIC_WEIGHT = 0x54475756u;  // "VWGT" little-endian
	constexpr uint32_t VERSION_V1 = 1u;

	enum class EDType : uint32_t {
		FLOAT32 = 0,
		UINT8 = 1,
	};

	struct FHeader {
		uint32_t magic;
		uint32_t version;
		uint32_t width;
		uint32_t height;
		uint32_t channels;
		uint32_t dtype;
		uint32_t reserved;
	};

	inline void write_header(std::ofstream& f, uint32_t magic, int w, int h, int ch, EDType dt) {
		FHeader hdr{
			magic,
			VERSION_V1,
			static_cast<uint32_t>(w),
			static_cast<uint32_t>(h),
			static_cast<uint32_t>(ch),
			static_cast<uint32_t>(dt),
			0u,
		};
		f.write(reinterpret_cast<const char*>(&hdr), sizeof(hdr));
	}

	// Сохраняет CV_32FC2 как remap. Содержимое — нормализованные [0..1] координаты исходника.
	inline bool save_remap(const std::filesystem::path& path, const cv::Mat& remap_32fc2) {
		if (remap_32fc2.empty() || remap_32fc2.type() != CV_32FC2) {
			return false;
		}
		std::filesystem::create_directories(path.parent_path());

		std::ofstream f(path, std::ios::binary);
		if (!f.is_open()) return false;

		write_header(f, MAGIC_REMAP, remap_32fc2.cols, remap_32fc2.rows, 2, EDType::FLOAT32);

		// row-major запись с учётом возможного шага.
		const size_t row_bytes = static_cast<size_t>(remap_32fc2.cols) * 2 * sizeof(float);
		for (int y = 0; y < remap_32fc2.rows; ++y) {
			f.write(reinterpret_cast<const char*>(remap_32fc2.ptr(y)),
				static_cast<std::streamsize>(row_bytes));
		}
		return f.good();
	}

	// Сохраняет CV_8UC1 как weight.
	inline bool save_weight(const std::filesystem::path& path, const cv::Mat& weight_8u) {
		if (weight_8u.empty() || weight_8u.type() != CV_8UC1) {
			return false;
		}
		std::filesystem::create_directories(path.parent_path());

		std::ofstream f(path, std::ios::binary);
		if (!f.is_open()) return false;

		write_header(f, MAGIC_WEIGHT, weight_8u.cols, weight_8u.rows, 1, EDType::UINT8);

		for (int y = 0; y < weight_8u.rows; ++y) {
			f.write(reinterpret_cast<const char*>(weight_8u.ptr(y)),
				static_cast<std::streamsize>(weight_8u.cols));
		}
		return f.good();
	}

	inline GLuint load_gl_map(const std::filesystem::path& path, int& out_w, int& out_h, ULogger* logger = nullptr) {
		out_w = out_h = 0;

		std::ifstream f(path, std::ios::binary);
		if (!f.is_open()) {
			if (logger) logger->error("load_gl_map(): cannot open " + path.string());
			return 0;
		}

		FHeader header{};
		f.read(reinterpret_cast<char*>(&header), sizeof(header));
		if (!f) {
			if (logger) logger->error("load_gl_map(): header read failed " + path.string());
			return 0;
		}

		GLenum internal_fmt = 0, fmt = 0, type = 0;
		size_t bytes_per_px = 0;

		if (header.magic == MAGIC_REMAP && header.channels == 2 && header.dtype == 0) {
			internal_fmt = GL_RG32F;
			fmt = GL_RG;
			type = GL_FLOAT;
			bytes_per_px = 2 * sizeof(float);
		}
		else if (header.magic == MAGIC_WEIGHT && header.channels == 1 && header.dtype == 1) {
			internal_fmt = GL_R8;
			fmt = GL_RED;
			type = GL_UNSIGNED_BYTE;
			bytes_per_px = 1;
		}
		else {
			if (logger) logger->error("load_gl_map(): unknown magic/format " + path.string());
			return 0;
		}

		const size_t total_bytes = static_cast<size_t>(header.width) * header.height * bytes_per_px;
		std::vector<uint8_t> blob(total_bytes);
		f.read(reinterpret_cast<char*>(blob.data()), static_cast<std::streamsize>(total_bytes));
		if (!f) {
			if (logger) logger->error("load_gl_map(): blob read failed " + path.string());
			return 0;
		}

		GLuint tex = 0;
		glGenTextures(1, &tex);
		glBindTexture(GL_TEXTURE_2D, tex);

		// REMAP — без интерполяции (значения координат, билинейное смешает невалидные с валидными → артефакты).
		// WEIGHT — линейная допустима, но возьмём NEAREST для предсказуемости.
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

		glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
		glTexImage2D(GL_TEXTURE_2D, 0, internal_fmt,
			static_cast<GLsizei>(header.width),
			static_cast<GLsizei>(header.height),
			0, fmt, type, blob.data()
		);

		GLenum err = glGetError();
		if (err != GL_NO_ERROR) {
			if (logger) logger->error("load_gl_map(): glTexImage2D error 0x" + std::to_string(err) + " for " + path.string());
			glDeleteTextures(1, &tex);
			return 0;
		}

		glBindTexture(GL_TEXTURE_2D, 0);

		out_w = static_cast<int>(header.width);
		out_h = static_cast<int>(header.height);
		return tex;
	}

} // namespace gl_maps
} // namespace varan