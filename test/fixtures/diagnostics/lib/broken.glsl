// A helper with a deliberate type error on line 5.
vec3 helper(vec2 p) {
    float t = iTime;
    vec3 c = vec3(p, t);
    vec2 bad = c;
    return c;
}
