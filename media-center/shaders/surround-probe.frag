#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 frag;

uniform sampler2D u_plane_y;
uniform sampler2D u_plane_uv;

// BT.601 как в камерном проходе: сравниваются те же цвета, что видит чаша
void main() {
    float y = texture(u_plane_y, v_uv).r;
    vec2 c = texture(u_plane_uv, v_uv).rg;
    float u = c.x - 0.5;
    float v = c.y - 0.5;
    frag = vec4(
        y + 1.402 * v,
        y - 0.344136 * u - 0.714136 * v,
        y + 1.772 * u,
        1.0);
}
