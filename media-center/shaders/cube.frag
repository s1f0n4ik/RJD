#version 300 es
precision mediump float;

in vec2 vUV;
flat in int vFace;

out vec4 FragColor;

// 6 камер * (Y + UV)
uniform sampler2D plane_y[6];
uniform sampler2D plane_uv[6];

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

void main()
{
    float y = 0.0;
    vec2 uv = vec2(0.0);

    switch (vFace)
    {
        case 0:
            y  = texture(plane_y[0], vUV).r;
            uv = texture(plane_uv[0], vUV).rg;
            break;
        case 1:
            y  = texture(plane_y[1], vUV).r;
            uv = texture(plane_uv[1], vUV).rg;
            break;
        case 2:
            y  = texture(plane_y[2], vUV).r;
            uv = texture(plane_uv[2], vUV).rg;
            break;
        case 3:
            y  = texture(plane_y[3], vUV).r;
            uv = texture(plane_uv[3], vUV).rg;
            break;
        case 4:
            y  = texture(plane_y[4], vUV).r;
            uv = texture(plane_uv[4], vUV).rg;
            break;
        case 5:
            y  = texture(plane_y[5], vUV).r;
            uv = texture(plane_uv[5], vUV).rg;
            break;
        default:
            // fallback (на случай мусора в vFace)
            y  = 0.0;
            uv = vec2(0.5, 0.5);
            break;
    }

    vec3 rgb = yuv_to_rgb(y, uv);
    FragColor = vec4(rgb, 1.0);
}