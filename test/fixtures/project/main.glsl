// main.glsl - fixture shader in shader-toy style.
#iChannel0 "file://buffer.glsl"
#iUniform float u_speed = 1.0 in { 0.0, 4.0 }

#include "lib/util.glsl"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = centered(fragCoord, iResolution.xy);
    fragColor = vec4(vec3(saturate(uv.x * u_speed)), 1.0);
}
