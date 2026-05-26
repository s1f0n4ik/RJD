#version 300 es
precision highp float;

in  vec2 v_uv;
out vec4 frag;

uniform sampler2D u_accum;
uniform int u_rotate_ccw;   // 1 повернуть на 90 против часовй

void main() {
    vec2 uv = v_uv;
    if (u_rotate_ccw == 1) {
        uv = vec2(1.0 - v_uv.y, v_uv.x);
    }

    vec4 acc = texture(u_accum, uv);
    float w  = acc.a;

    if (w <= 0.0) {
        frag = vec4(0.3, 0.3, 0.3, 0.7);
        return;
    }
    frag = vec4(acc.rgb / w, 1.0);
}
