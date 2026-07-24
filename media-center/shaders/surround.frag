#version 300 es
precision highp float;

in vec3 v_world;
in vec3 v_normal;
in vec3 v_uvw;
out vec4 frag;

// 0 - проход камеры в накопитель, 1 - габарит, 2 - сетка без камер
uniform int u_mode;
uniform vec3 u_color;
// Шаг сетки в метрах, масштабируется от габарита
uniform float u_grid_step;

uniform sampler2D u_plane_y;
uniform sampler2D u_plane_uv;

void main() {
    if (u_mode == 1) {
        // Свет фиксированный, сверху-сбоку, чтобы грани различались
        vec3 light = normalize(vec3(0.4, 1.0, 0.3));
        float shade = 0.35 + 0.65 * abs(dot(normalize(v_normal), light));
        frag = vec4(u_color * shade, 1.0);
        return;
    }

    if (u_mode == 2) {
        vec2 cell = abs(fract(v_world.xz / u_grid_step) - 0.5);
        float line = smoothstep(0.46, 0.5, max(cell.x, cell.y));
        frag = vec4(mix(u_color, u_color * 1.8, line), 1.0);
        return;
    }

    // Проход камеры: rgb с весом в накопитель, вес в альфе. BT.601 как у сшивки
    // Вес = секторный вес камеры на клин смешивания x затухание у края кадра
    vec2 uv = v_uvw.xy;
    float border = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    float w = clamp(border * 8.0, 0.0, 1.0) * clamp(v_uvw.z, 0.0, 1.0);
    if (w <= 0.0) {
        frag = vec4(0.0);
        return;
    }

    float y = texture(u_plane_y, uv).r;
    vec2 c = texture(u_plane_uv, uv).rg;
    float u = c.x - 0.5;
    float v = c.y - 0.5;
    vec3 rgb = vec3(
        y + 1.402 * v,
        y - 0.344136 * u - 0.714136 * v,
        y + 1.772 * u);

    frag = vec4(rgb * w, w);
}
