#version 300 es

layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
// Запечённые для текущей камеры прохода: u, v, вес; у модели это uv, 0
layout(location = 2) in vec3 a_uvw;

uniform mat4 u_mvp;
// Единичная для чаши и бокса; вписывание и поворот загруженной модели
uniform mat4 u_model;

out vec3 v_world;
out vec3 v_normal;
out vec3 v_uvw;

void main() {
    vec4 world = u_model * vec4(a_pos, 1.0);
    v_world = world.xyz;
    // Масштаб модели равномерный, обратной транспонированной не нужно
    v_normal = mat3(u_model) * a_normal;
    v_uvw = a_uvw;
    gl_Position = u_mvp * world;
}
