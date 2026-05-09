#pragma once

#include <string>
#include <fstream>
#include <sstream>
#include <iostream>
#include <unordered_map>
#include <filesystem>

#include <GLES3/gl3.h>

#include "logger.h"

namespace varan {
namespace birdview {

    class UShader {
        using path = std::filesystem::path;
    public:
        UShader();

        ~UShader();

        // Загрузка шейдеров из файлов
        bool load_from_files(const path& vertex_path, const path& fragment_path, ULogger* logger = nullptr);

        // Компиляция шейдера из исходного кода
        bool load_from_source(const char* vertex_source, const char* fragment_source, ULogger* logger = nullptr);

        // Использование шейдера
        void use() const;

        // Установка uniform-переменных
        void set_bool(const std::string& name, bool value) const;

        void set_int(const std::string& name, int value) const;

        void set_float(const std::string& name, float value) const;

        GLuint get_id() const;

    private:
        GLuint m_id;

        bool read_file(const path& path, std::string& out_code, ULogger* logger = nullptr);
    };

} // bridview
} // varan