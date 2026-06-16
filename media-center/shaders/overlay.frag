#version 300 es
precision highp float;

in  vec2 v_uv;
out vec4 frag;

uniform sampler2D u_tex;
uniform int u_rotate_ccw;

void main() {
    vec2 uv = v_uv;
    if (u_rotate_ccw == 1) {
        uv = vec2(1.0 - v_uv.y, v_uv.x);
    }
    frag = texture(u_tex, uv);
}