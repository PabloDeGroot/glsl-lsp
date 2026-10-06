#include "lib/broken.glsl"

#iUniform float u_speed = 1.0 in { 0.0, 4.0 }
#iUniform color3 u_tint = color3(1.0, 0.5, 0.2)

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    fragColor = vec4(helper(uv) * u_tint * u_speed, 1.0);
}
