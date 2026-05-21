#version 300 es
// Полноэкранный quad: триггерится одним вызовом glDrawArrays(GL_TRIANGLES, 0, 3)
// без VBO. Покрывает весь viewport.

out vec2 v_uv;

void main() {
    // Большой треугольник: вершины (-1,-1), (3,-1), (-1,3)
    // покрывает весь экран [-1..1]^2.
    vec2 pos = vec2(
        float((gl_VertexID == 1)) * 4.0 - 1.0,
        float((gl_VertexID == 2)) * 4.0 - 1.0
    );
    v_uv = pos * 0.5 + 0.5;  // [0..1]
    gl_Position = vec4(pos, 0.0, 1.0);
}
