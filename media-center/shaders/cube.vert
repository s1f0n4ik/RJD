#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUV;
layout(location = 2) in int aFace;

uniform mat4 MVP;

out vec2 vUV;
flat out int vFace;

void main()
{
    vUV = aUV;
    vFace = aFace;
    gl_Position = MVP * vec4(aPos, 1.0);
}