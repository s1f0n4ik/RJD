#version 300 es
precision highp float;

in vec2 vUV;
out vec4 FragColor;

uniform sampler2D texY;
uniform sampler2D texUV;
// Карты коррекции: абсолютные координаты источника в пикселях (CV_32FC1)
uniform sampler2D mapX;
uniform sampler2D mapY;
uniform vec2 srcSize;

void main() {
    float sx = texture(mapX, vUV).r;
    float sy = texture(mapY, vUV).r;
    vec2 srcUV = vec2(sx, sy) / srcSize;

    if (srcUV.x < 0.0 || srcUV.x > 1.0 || srcUV.y < 0.0 || srcUV.y > 1.0) {
        FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    float y = texture(texY, srcUV).r;

    vec2 uv = texture(texUV, srcUV).rg;
    float u = uv.x - 0.5;
    float v = uv.y - 0.5;

    // BT.601
    float r = y + 1.402 * v;
    float g = y - 0.344136 * u - 0.714136 * v;
    float b = y + 1.772 * u;

    FragColor = vec4(r, g, b, 1.0);
}
