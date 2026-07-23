#version 300 es
precision highp float;

in  vec2 v_uv;
out vec4 frag;

uniform sampler2D u_tex;
// Четверти оборота против часовой: 0, 1, 2, 3 — то есть 0, 90, 180, 270
uniform int u_rotation;

// Обратное преобразование: по точке вывода берём точку исходной картинки
vec2 rotate_uv(vec2 uv, int quarters) {
    if (quarters == 1) return vec2(1.0 - uv.y, uv.x);
    if (quarters == 2) return vec2(1.0 - uv.x, 1.0 - uv.y);
    if (quarters == 3) return vec2(uv.y, 1.0 - uv.x);
    return uv;
}

void main() {
    frag = texture(u_tex, rotate_uv(v_uv, u_rotation));
}