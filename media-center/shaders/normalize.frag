#version 300 es
precision highp float;

in  vec2 v_uv;
out vec4 frag;

uniform sampler2D u_accum;  // RGBA из FBO накопления

void main() {
    //float w = texture(u_accum, v_uv).a;
    //frag = vec4(w, w, w, 1.0);  // визуализация суммарного веса

    vec4 acc = texture(u_accum, v_uv);
    float w  = acc.a;

    if (acc.a <= 0.0) {
        frag = vec4(0.3, 0.3, 0.3, 0.7);
        return;
    }
    frag = vec4(acc.rgb / w, 1.0);
}
