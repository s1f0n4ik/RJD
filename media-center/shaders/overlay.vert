#version 300 es

out vec2 v_uv;

uniform vec4 u_rect;      // x, y, w, h в пикселях canvas
uniform vec2 u_canvas;    // ширина, высота viewport

void main() {
    // Квад из двух треугольников через gl_VertexID (6 вершин)
    vec2 corner = vec2(
        float(gl_VertexID == 1 || gl_VertexID == 2 || gl_VertexID == 4),
        float(gl_VertexID == 2 || gl_VertexID == 4 || gl_VertexID == 5)
    );

    v_uv = vec2(corner.x, corner.y);  // flip Y для текстуры

    // Пиксельные координаты → NDC
    vec2 px = u_rect.xy + corner * u_rect.zw;
    vec2 ndc = (px / u_canvas) * 2.0 - 1.0;
    ndc.y = -ndc.y;  // OpenGL Y вверх

    gl_Position = vec4(ndc, 0.0, 1.0);
}