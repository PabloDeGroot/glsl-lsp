// lib/util.glsl - fixture helpers.

#include "../vendor/math/saturate.glsl"

// Centered, aspect-corrected coordinates.
vec2 centered(vec2 fragCoord, vec2 res) { return (fragCoord * 2.0 - res) / res.y; }
