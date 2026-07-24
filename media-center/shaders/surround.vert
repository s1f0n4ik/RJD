#version 300 es

layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
// Запечённые для текущей камеры прохода: u, v, вес
layout(location = 2) in vec3 a_uvw;

uniform mat4 u_mvp;

out vec3 v_world;
out vec3 v_normal;
out vec3 v_uvw;

void main() {
    // Модельная матрица единичная, позиция вершины и есть мировая
    v_world = a_pos;
    v_normal = a_normal;
    v_uvw = a_uvw;
    gl_Position = u_mvp * vec4(a_pos, 1.0);
}
