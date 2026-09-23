#version 300 es

layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUV;

// Окно источника в долях кадра: смещение и размер
uniform vec2 uvOffset;
uniform vec2 uvScale;

out vec2 vUV;

void main() {
    vUV = uvOffset + aUV * uvScale;
    gl_Position = vec4(aPos, 0.0, 1.0);
}
