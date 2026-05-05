#version 300 es
precision mediump float;

in vec2 vUV;
flat in int vFace;

out vec4 FragColor;

// 6 камер, по 2 текстуры на камеру
uniform highp sampler2D plane_y[6];
uniform highp sampler2D plane_uv[6];
uniform int is_exists[6];

// YUV -> RGB (NV12)
vec3 yuv_to_rgb(float y, vec2 uv)
{
    float u = uv.x - 0.5;
    float v = uv.y - 0.5;

    return vec3(
        y + 1.402 * v,
        y - 0.344 * u - 0.714 * v,
        y + 1.772 * u
    );
}

vec3 sample_nv12(int idx, vec2 uv)
{
    if (idx == 0) {
        float y = texture(plane_y[0], uv).r;
        vec2 uv_sample = texture(plane_uv[0], uv).rg;
        return yuv_to_rgb(y, uv_sample);
    }
    else if (idx == 1) {
        float y = texture(plane_y[1], uv).r;
        vec2 uv_sample = texture(plane_uv[1], uv).rg;
        return yuv_to_rgb(y, uv_sample);
    }
    else if (idx == 2) {
        float y = texture(plane_y[2], uv).r;
        vec2 uv_sample = texture(plane_uv[2], uv).rg;
        return yuv_to_rgb(y, uv_sample);
    }
    else if (idx == 3) {
        float y = texture(plane_y[3], uv).r;
        vec2 uv_sample = texture(plane_uv[3], uv).rg;
        return yuv_to_rgb(y, uv_sample);
    }
    else if (idx == 4) {
        float y = texture(plane_y[4], uv).r;
        vec2 uv_sample = texture(plane_uv[4], uv).rg;
        return yuv_to_rgb(y, uv_sample);
    }
    else if (idx == 5) {
        float y = texture(plane_y[5], uv).r;
        vec2 uv_sample = texture(plane_uv[5], uv).rg;
        return yuv_to_rgb(y, uv_sample);
    }

    return vec3(0.5);
}

void main()
{
    vec3 rgb = vec3(0.5); // fallback

    switch(vFace)
    {
        case 0:
            if (is_exists[0] > 0) rgb = sample_nv12(0, vUV);
            break;
        case 1:
            if (is_exists[1] > 0) rgb = sample_nv12(1, vUV);
            break;
        case 2:
            if (is_exists[2] > 0) rgb = sample_nv12(2, vUV);
            break;
        case 3:
            if (is_exists[3] > 0) rgb = sample_nv12(3, vUV);
            break;
        case 4:
            if (is_exists[4] > 0) rgb = sample_nv12(4, vUV);
            break;
        case 5:
            if (is_exists[5] > 0) rgb = sample_nv12(5, vUV);
            break;
        default:
            break;
    }

    FragColor = vec4(rgb, 1.0);
}