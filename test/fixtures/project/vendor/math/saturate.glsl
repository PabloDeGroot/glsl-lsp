/*
contributors: Fixture
description: clamp a value between 0 and 1
use: <float|vec2|vec3|vec4> saturate(<float|vec2|vec3|vec4> value)
*/

#if !defined(FNC_SATURATE) && !defined(saturate)
#define FNC_SATURATE
#define saturate(V) clamp(V, 0.0, 1.0)
#endif
