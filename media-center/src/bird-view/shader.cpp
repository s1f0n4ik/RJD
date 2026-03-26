#include "bird-view/shader.h"

namespace varan {
namespace birdview {
	
    UShader::UShader() : m_id(0) {}
    UShader::~UShader() {
        if (m_id) {
            glDeleteProgram(m_id);
        }
    }

    bool UShader::load_from_files(const path& vertex_path, const path& fragment_path, ULogger* logger) {
        std::string vertex_code;
        std::string fragment_code;

        if (!read_file(vertex_path, vertex_code, logger)) {
            if (logger) logger->error("Cannot read vertex shader from " + vertex_path.string());
            return false;
        }
        if (!read_file(fragment_path, fragment_code, logger)) {
            if (logger) logger->error("Cannot read fragment shader from " + fragment_path.string());
            return false;
        }

        return load_from_source(vertex_code.c_str(), fragment_code.c_str(), logger);
    }

    bool UShader::load_from_source(const char* vertex_source, const char* fragment_source, ULogger* logger) {
        GLuint vertex, fragment;
        GLint success;
        GLchar infoLog[512];

        vertex = glCreateShader(GL_VERTEX_SHADER);
        glShaderSource(vertex, 1, &vertex_source, nullptr);
        glCompileShader(vertex);
        glGetShaderiv(vertex, GL_COMPILE_STATUS, &success);
        if (!success) {
            glGetShaderInfoLog(vertex, 512, nullptr, infoLog);
            if (logger) logger->error("Error with compiling vertex shader from source: " + std::string(infoLog));
            return false;
        }

        fragment = glCreateShader(GL_FRAGMENT_SHADER);
        glShaderSource(fragment, 1, &fragment_source, nullptr);
        glCompileShader(fragment);
        glGetShaderiv(fragment, GL_COMPILE_STATUS, &success);
        if (!success) {
            glGetShaderInfoLog(fragment, 512, nullptr, infoLog);
            if (logger) logger->error("Error with compiling fragment shader from source: " + std::string(infoLog));
            return false;
        }

        m_id = glCreateProgram();
        glAttachShader(m_id, vertex);
        glAttachShader(m_id, fragment);
        glLinkProgram(m_id);

        glGetProgramiv(m_id, GL_LINK_STATUS, &success);
        if (!success) {
            glGetProgramInfoLog(m_id, 512, nullptr, infoLog);
            if (logger) logger->error("Error with linking shader program: " + std::string(infoLog));
            return false;
        }

        glDeleteShader(vertex);
        glDeleteShader(fragment);

        return true;
    }

    void UShader::use() const {
        glUseProgram(m_id);
    }

    void UShader::set_bool(const std::string& name, bool value) const {
        glUniform1i(glGetUniformLocation(m_id, name.c_str()), (int)value);
    }

    void UShader::set_int(const std::string& name, int value) const {
        glUniform1i(glGetUniformLocation(m_id, name.c_str()), value);
    }

    void UShader::set_float(const std::string& name, float value) const {
        glUniform1f(glGetUniformLocation(m_id, name.c_str()), value);
    }

    GLuint UShader::get_id() const { return m_id; }


bool UShader::read_file(const path& path, std::string& outCode, ULogger* logger) {
    if (!std::filesystem::exists(path)) {
        if (logger) logger->error("read_file(): path to the shader " + path.string() + " doesn't exist!");
        return false;
    }
    std::ifstream file(path);
    if (!file.is_open()) {
        if (logger) logger->error("read_file(): cannot open the file at path " + path.string());
        return false;
    }
    std::stringstream stream;
    stream << file.rdbuf();
    outCode = stream.str();
    if (logger) logger->debug("read_file(): successfully read shader at path " + path.string());
    return true;
}

} // birdview
} // varan