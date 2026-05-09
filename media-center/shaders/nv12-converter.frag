#version 300 es
precision highp float;

in vec2 vUV;
out vec4 FragColor;

uniform sampler2D texY;
uniform sampler2D texUV;

void main() {
    float y = texture(texY, vUV).r;

    vec2 uv = texture(texUV, vUV).rg;
    float u = uv.x - 0.5;
    float v = uv.y - 0.5;

    // BT.601
    float r = y + 1.402 * v;
    float g = y - 0.344136 * u - 0.714136 * v;
    float b = y + 1.772 * u;

    FragColor = vec4(r, g, b, 1.0);
}