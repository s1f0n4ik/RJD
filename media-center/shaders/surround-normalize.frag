#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 frag;

// Накопитель RGBA16F: rgb с весами, сумма весов в альфе
uniform sampler2D u_accum;

void main() {
    vec4 acc = texture(u_accum, v_uv);
    if (acc.a <= 0.001) {
        // Сюда камеры не смотрят
        frag = vec4(0.05, 0.06, 0.08, 1.0);
        return;
    }
    frag = vec4(acc.rgb / acc.a, 1.0);
}
