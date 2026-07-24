#version 300 es

// Пробник фотонормализации: точка = пиксель выборки в крошечном FBO
layout(location = 0) in vec2 a_ndc;
layout(location = 1) in vec2 a_uv;

out vec2 v_uv;

void main() {
    v_uv = a_uv;
    gl_Position = vec4(a_ndc, 0.0, 1.0);
    gl_PointSize = 1.0;
}
