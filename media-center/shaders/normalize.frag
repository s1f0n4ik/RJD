#version 300 es
precision highp float;

in  vec2 v_uv;
out vec4 frag;

uniform sampler2D u_accum;
// Четверти оборота против часовой: 0, 1, 2, 3 — то есть 0, 90, 180, 270
uniform int u_rotation;

// Обратное преобразование: по точке вывода берём точку исходного канваса
vec2 rotate_uv(vec2 uv, int quarters) {
    if (quarters == 1) return vec2(1.0 - uv.y, uv.x);
    if (quarters == 2) return vec2(1.0 - uv.x, 1.0 - uv.y);
    if (quarters == 3) return vec2(uv.y, 1.0 - uv.x);
    return uv;
}

void main() {
    vec2 uv = rotate_uv(v_uv, u_rotation);

    vec4 acc = texture(u_accum, uv);
    float w  = acc.a;

    // Непокрытые места чёрные: совпадает с полями вписывания
    if (w <= 0.0) {
        frag = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }
    frag = vec4(acc.rgb / w, 1.0);
}
