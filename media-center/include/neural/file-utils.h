#pragma once

#include <fstream>
#include <vector>
#include <string>
#include <cstdint>
#include <iostream>

namespace varan {
namespace neural {

	/*
		Загрузка бинарного файла. Возвращает содержимое в vector<uint8_t>.
		Пустой vector — ошибка (файл не открылся / не читается).
	*/
	inline std::vector<uint8_t> load_model(const std::string& filename) {
		std::ifstream f(filename, std::ios::binary | std::ios::ate);
		if (!f.is_open()) {
			std::cerr << "load_model(): cannot open " << filename << std::endl;
			return {};
		}
		const std::streamsize size = f.tellg();
		if (size <= 0) return {};

		std::vector<uint8_t> buf(static_cast<size_t>(size));
		f.seekg(0, std::ios::beg);
		if (!f.read(reinterpret_cast<char*>(buf.data()), size)) {
			std::cerr << "load_model(): read failed for " << filename << std::endl;
			return {};
		}
		return buf;
	}

	/*
		Прочитать файл как текст в std::string.
		Возвращает пустой string в случае ошибки. Размер можно узнать через .size().
	*/
	inline std::string read_text_file(const std::string& path) {
		std::ifstream f(path, std::ios::binary | std::ios::ate);
		if (!f.is_open()) {
			std::cerr << "read_text_file(): cannot open " << path << std::endl;
			return {};
		}
		const std::streamsize size = f.tellg();
		if (size <= 0) return {};

		std::string out;
		out.resize(static_cast<size_t>(size));
		f.seekg(0, std::ios::beg);
		if (!f.read(out.data(), size)) {
			std::cerr << "read_text_file(): read failed for " << path << std::endl;
			return {};
		}
		return out;
	}

	/*
		Записать буфер в файл. true — успех.
	*/
	inline bool write_data_to_file(const std::string& path, const void* data, size_t size) {
		std::ofstream f(path, std::ios::binary | std::ios::trunc);
		if (!f.is_open()) {
			std::cerr << "write_data_to_file(): cannot open " << path << std::endl;
			return false;
		}
		f.write(reinterpret_cast<const char*>(data), static_cast<std::streamsize>(size));
		return f.good();
	}

	inline bool write_data_to_file(const std::string& path, const std::string& data) {
		return write_data_to_file(path, data.data(), data.size());
	}

	inline bool write_data_to_file(const std::string& path, const std::vector<uint8_t>& data) {
		return write_data_to_file(path, data.data(), data.size());
	}

	/*
		Прочитать файл построчно. Пустые строки в конце не добавляются.
	*/
	inline std::vector<std::string> read_lines_from_file(const std::string& filename) {
		std::vector<std::string> lines;
		std::ifstream f(filename);
		if (!f.is_open()) {
			std::cerr << "read_lines_from_file(): cannot open " << filename << std::endl;
			return lines;
		}
		std::string line;
		while (std::getline(f, line)) {
			// std::getline уже убирает '\n'; убираем '\r' если файл с Windows-окончаниями
			if (!line.empty() && line.back() == '\r') line.pop_back();
			lines.push_back(std::move(line));
		}
		return lines;
	}

} // namespace neural
} // namespace varan