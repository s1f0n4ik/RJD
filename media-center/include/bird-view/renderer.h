#pragma once

#include <optional>

#include "gl-dmabuf-image.h"
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
        virtual bool init(int textures_count, ULogger* logger = nullptr) = 0;

        // обновление состояния
        virtual void update(float dt) = 0;

        // Обновление изображений с камер
        virtual void update_textures(std::vector<std::optional<FDmabufFrame>>& frames, EGLDisplay display = nullptr) = 0;

        // отрисовка
        virtual void render(float aspect) = 0;
    };

    class UCubeRenderer : public IRenderer
    {
    public:

        bool init(int textures_count, ULogger* logger = nullptr) override;
        void update(float dt) override;
        void update_textures(std::vector<std::optional<FDmabufFrame>>& frames, EGLDisplay display = nullptr) override;
        void render(float aspect) override;

    private:
        void create_cube();

    private:
        UShader m_shader;
        FEGLContext m_context;

        GLuint m_vao = 0;
        GLuint m_vbo = 0;

        float m_angle = 0.0f;

        std::vector<UGLDmabufImage> m_gl_images;

        ULogger* m_logger;
    };

} // birdview
} // varan