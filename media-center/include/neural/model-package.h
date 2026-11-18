#pragma once

#include <cstdint>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include "neural/file-utils.h"

namespace varan {
namespace neural {

	/*
		Контейнер модели .rjdm: ZIP без сжатия с manifest.json и weights.rknn.
		Устройству нужны только веса; манифест (классы, размер входа) читает мастер при загрузке файла,
		а целостность файла проверяет sha256 ассета при приёме конфигурации.
		Формат описан в «Формат модели RJDM.md».
	*/
	inline bool is_model_package(const std::string& path) {
		constexpr const char* ext = ".rjdm";
		constexpr size_t len = 5;
		return path.size() >= len && path.compare(path.size() - len, len, ext) == 0;
	}

	namespace package_detail {

		inline uint32_t le16(const uint8_t* p) { return static_cast<uint32_t>(p[0]) | static_cast<uint32_t>(p[1]) << 8; }
		inline uint32_t le32(const uint8_t* p) { return le16(p) | le16(p + 2) << 16; }

		inline bool read_at(std::ifstream& f, uint64_t offset, void* out, size_t size) {
			f.clear();
			f.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
			return static_cast<bool>(f.read(static_cast<char*>(out), static_cast<std::streamsize>(size)));
		}

		// Положение файла name в архиве: смещение данных и размер; false, если его нет или он сжат
		inline bool find_entry(std::ifstream& f, uint64_t file_size, const std::string& name, uint64_t& offset, uint64_t& size, std::string& error) {
			// Конец центрального каталога лежит в последних 22 байтах плюс комментарий до 64 КБ
			const uint64_t tail_size = file_size < 22 + 65535 ? file_size : 22 + 65535;
			std::vector<uint8_t> tail(static_cast<size_t>(tail_size));
			if (tail_size < 22 || !read_at(f, file_size - tail_size, tail.data(), tail.size())) { error = "not a ZIP archive"; return false; }
			size_t end = tail.size() - 22 + 1;
			while (end-- > 0) {
				if (le32(&tail[end]) == 0x06054b50) break;
			}
			if (end == static_cast<size_t>(-1)) { error = "not a ZIP archive"; return false; }

			const uint32_t count = le16(&tail[end + 10]);
			const uint32_t dir_size = le32(&tail[end + 12]);
			const uint32_t dir_offset = le32(&tail[end + 16]);
			if (count == 0xFFFF || dir_size == 0xFFFFFFFF || dir_offset == 0xFFFFFFFF) { error = "ZIP64 is not supported"; return false; }
			if (static_cast<uint64_t>(dir_offset) + dir_size > file_size) { error = "broken ZIP directory"; return false; }

			std::vector<uint8_t> dir(dir_size);
			if (!read_at(f, dir_offset, dir.data(), dir.size())) { error = "cannot read ZIP directory"; return false; }

			size_t pos = 0;
			for (uint32_t i = 0; i < count; ++i) {
				if (pos + 46 > dir.size() || le32(&dir[pos]) != 0x02014b50) { error = "broken ZIP directory"; return false; }
				const uint32_t method = le16(&dir[pos + 10]);
				const uint32_t packed = le32(&dir[pos + 20]);
				const uint32_t plain = le32(&dir[pos + 24]);
				const uint32_t name_len = le16(&dir[pos + 28]);
				const uint32_t extra_len = le16(&dir[pos + 30]);
				const uint32_t comment_len = le16(&dir[pos + 32]);
				const uint32_t header = le32(&dir[pos + 42]);
				if (pos + 46 + name_len > dir.size()) { error = "broken ZIP directory"; return false; }

				if (std::string(reinterpret_cast<const char*>(&dir[pos + 46]), name_len) == name) {
					if (method != 0 || packed != plain) { error = name + " is compressed, it must be stored"; return false; }
					uint8_t local[30];
					if (!read_at(f, header, local, sizeof(local)) || le32(local) != 0x04034b50) { error = "broken ZIP entry " + name; return false; }
					offset = static_cast<uint64_t>(header) + 30 + le16(local + 26) + le16(local + 28);
					size = plain;
					if (offset + size > file_size) { error = "ZIP entry " + name + " is cut off"; return false; }
					return true;
				}
				pos += 46 + name_len + extra_len + comment_len;
			}
			error = name + " is missing in the archive";
			return false;
		}

	} // namespace package_detail

	/*
		weights.rknn из .rjdm. Пустой vector — ошибка (файл не открылся, нет weights.rknn, он сжат).
	*/
	inline std::vector<uint8_t> load_package_weights(const std::string& path) {
		std::ifstream f(path, std::ios::binary | std::ios::ate);
		if (!f.is_open()) {
			std::cerr << "load_package_weights(): cannot open " << path << std::endl;
			return {};
		}
		const uint64_t file_size = static_cast<uint64_t>(f.tellg());
		uint64_t offset = 0, size = 0;
		std::string error;
		if (!package_detail::find_entry(f, file_size, "weights.rknn", offset, size, error) || size == 0) {
			std::cerr << "load_package_weights(): " << path << ": " << (error.empty() ? "weights.rknn is empty" : error) << std::endl;
			return {};
		}
		std::vector<uint8_t> weights(static_cast<size_t>(size));
		if (!package_detail::read_at(f, offset, weights.data(), weights.size())) {
			std::cerr << "load_package_weights(): read failed for " << path << std::endl;
			return {};
		}
		return weights;
	}

	/*
		Веса модели по пути: из контейнера .rjdm или голый .rknn.
	*/
	inline std::vector<uint8_t> load_model_weights(const std::string& path) {
		return is_model_package(path) ? load_package_weights(path) : load_model(path);
	}

} // namespace neural
} // namespace varan
