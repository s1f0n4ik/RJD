#version 300 es
precision highp float;

in  vec2 v_uv;
out vec4 frag;

uniform sampler2D u_remap;     // RG32F, нормализованные [0..1] UV исходного кадра.
                               // Значения (-1,-1) — невалидный пиксель.
uniform sampler2D u_weight;    // R8, нормализуется sampler'ом в [0..1].

uniform sampler2D u_plane_y;   // NV12 Y
uniform sampler2D u_plane_uv;  // NV12 UV (interleaved)

uniform int u_has_frame;

void main() {
    if (u_has_frame == 0) {
        frag = vec4(0.0);
        return;
    }

    vec2 raw_uv = texture(u_remap, v_uv).rg;
    if (raw_uv.x < 0.0 || raw_uv.y < 0.0) {
        frag = vec4(0.0);
        return;
    }

    float w = texture(u_weight, v_uv).r;
    if (w <= 0.0) {
        frag = vec4(0.0);
        return;
    }

    // BT.601 — твоя проверенная матрица.
    float y  = texture(u_plane_y, raw_uv).r;
    vec2  uv = texture(u_plane_uv, raw_uv).rg;
    float u  = uv.x - 0.5;
    float v  = uv.y - 0.5;

    float r = y + 1.402    * v;
    float g = y - 0.344136 * u - 0.714136 * v;
    float b = y + 1.772    * u;

    frag = vec4(vec3(r, g, b) * w, w);
}
