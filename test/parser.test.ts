import { describe, expect, it } from 'vitest';
import { callAt, activeArgument, localsAt, type VariableSymbol } from '../server/src/core';
import { cursor, parseText } from './helpers';

const SAMPLE = `#version 300 es
precision highp float;

struct Ray { vec3 origin; vec3 dir; float t[2]; };

uniform vec2 u_res;
const float PI2 = 6.28318, HALF = 0.5;
layout(std140) uniform Block { mat4 mvp; vec4 tint; } ubo;
in vec2 vUv;

float sdSphere(vec3 p, float r);

float sdSphere(vec3 p, float r) { return length(p) - r; }
float sdSphere(vec3 p) { return sdSphere(p, 1.0); }

vec3 march(in Ray ray, out float dist) {
    float t = 0.0;
    for (int i = 0; i < 64; i++) {
        vec3 p = ray.origin + ray.dir * t;
        float d = sdSphere(p, HALF);
        t += d;
    }
    dist = t;
    return ray.origin.xyz;
}
`;

describe('parser: declarations', () => {
  const m = parseText(SAMPLE);

  it('finds functions, overloads and prototypes', () => {
    const names = m.functions.map((f) => `${f.name}/${f.params.length}${f.isPrototype ? 'p' : ''}`);
    expect(names).toEqual(['sdSphere/2p', 'sdSphere/2', 'sdSphere/1', 'march/2']);
    const march = m.functions[3];
    expect(march.returnType.name).toBe('vec3');
    expect(march.params.map((p) => [p.qualifiers.join(' '), p.type.name, p.name])).toEqual([
      ['in', 'Ray', 'ray'],
      ['out', 'float', 'dist'],
    ]);
    expect(march.bodyRange).toBeDefined();
  });

  it('finds structs with fields', () => {
    expect(m.structs).toHaveLength(1);
    expect(m.structs[0].fields.map((f) => f.name + (f.type.array ?? ''))).toEqual(['origin', 'dir', 't[2]']);
  });

  it('finds globals with qualifiers and initializers, and interface blocks', () => {
    const g = Object.fromEntries(m.globals.map((v) => [v.name, v]));
    expect(g['u_res'].qualifiers).toEqual(['uniform']);
    expect(g['PI2'].initializer).toBe('6.28318');
    expect(g['HALF'].qualifiers).toEqual(['const']);
    expect(g['vUv'].qualifiers).toEqual(['in']);
    expect(g['ubo'].type.name).toBe('Block');
    expect(m.blocks[0]).toMatchObject({ name: 'Block', instanceName: 'ubo' });
    expect(m.blocks[0].fields.map((f) => f.name)).toEqual(['mvp', 'tint']);
    expect(m.blocks[0].layout).toBe('layout(std140)');
  });

  it('reads #version', () => {
    expect(m.glslVersion).toMatchObject({ number: 300, profile: 'es' });
  });

  it('builds scopes with locals visible after their declaration', () => {
    const offsetInLoop = SAMPLE.indexOf('t += d') ;
    const names = localsAt(m, offsetInLoop).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['d', 'p', 'i', 't', 'ray', 'dist']));
    const beforeT = SAMPLE.indexOf('float t = 0.0');
    expect(localsAt(m, beforeT).map((s) => s.name)).not.toContain('t');
  });

  it('records calls with argument ranges and member receivers', () => {
    const call = m.calls.find((c) => c.name === 'sdSphere' && c.args.length === 2 && c.closeParen !== undefined && SAMPLE.slice(0, c.openParen).includes('float d'))!;
    expect(call).toBeDefined();
    const argText = call.args.map((r) => SAMPLE.split('\n')[r.start.line].slice(r.start.character, r.end.character));
    expect(argText).toEqual(['p', 'HALF']);
    const member = m.occurrences.find((o) => o.role === 'member' && o.name === 'dir')!;
    expect(m.occurrences[member.receiver!].name).toBe('ray');
    const xyz = m.occurrences.find((o) => o.role === 'member' && o.name === 'xyz')!;
    expect(m.occurrences[xyz.receiver!].name).toBe('origin');
  });

  it('records type occurrences for user types', () => {
    expect(m.occurrences.some((o) => o.role === 'type' && o.name === 'Ray')).toBe(true);
  });
});

describe('parser: tolerance', () => {
  it('keeps going after a missing closing brace (next function is still found)', () => {
    const m = parseText('void a() {\n  float x = 1.0;\n\nvoid b() { }\n');
    expect(m.functions.map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('keeps unclosed calls while typing, with the argument so far', () => {
    const { text, offset } = cursor('void main() {\n  vec3 c = mix(a, |\n}\nfloat g() { return 1.0; }');
    const m = parseText(text);
    const call = callAt(m, offset)!;
    expect(call.name).toBe('mix');
    expect(call.closeParen).toBeUndefined();
    expect(activeArgument(call, offset)).toBe(1);
    expect(m.functions.map((f) => f.name)).toEqual(['main', 'g']);
  });

  it('recovers from a missing semicolon', () => {
    const m = parseText('void main() {\n  float a = foo(1)\n  float b = 2.0;\n}');
    const locals = m.functions[0].scope!.symbols.map((s) => s.name);
    expect(locals).toEqual(['a', 'b']);
  });

  it('parses statement-level garbage without throwing', () => {
    const inputs = ['', '}', ')))', 'float', 'float x(', 'struct', 'struct {', 'uniform Foo {', 'void f(int', '#define', 'a.b.c.', 'for(;;', '{{{{', 'x = [1,2'];
    for (const s of inputs) expect(() => parseText(s)).not.toThrow();
  });

  it('never throws on any prefix of a real shader (simulated typing)', () => {
    for (let i = 0; i <= SAMPLE.length; i += 3) {
      const m = parseText(SAMPLE.slice(0, i));
      expect(m.issues.filter((x) => x.message.startsWith('internal'))).toEqual([]);
    }
  });

  it('accepts macro qualifiers and soft keywords used as names (LYGIA style)', () => {
    const m = parseText(
      'float tn(HIGHP in vec2 st) {\n  HIGHP float xy = st.x;\n  SAMPLE_T sample = FNC(st);\n  sample = 1.0;\n  return xy;\n}\nvec3 centroid(const in AABB _box) { return (_box.min + _box.max) * 0.5; }',
    );
    expect(m.issues).toEqual([]);
    expect(m.functions.map((f) => f.name)).toEqual(['tn', 'centroid']);
    expect(m.functions[0].params[0]).toMatchObject({ name: 'st', qualifiers: ['HIGHP', 'in'] });
    expect(m.functions[0].scope!.symbols.map((s) => s.name)).toEqual(['st', 'xy', 'sample']);
  });

  it('parses only the first branch when branches do not balance braces', () => {
    const text = [
      'float f(int N) {',
      '  float s = 0.0;',
      '#ifdef WEBGL',
      '  for (int i = 0; i < 20; i++) {',
      '    if (i >= N) break;',
      '#else',
      '  for (int i = 0; i < N; i++) {',
      '#endif',
      '    s += 1.0;',
      '  }',
      '  return s;',
      '}',
      'float g() { return f(2); }',
    ].join('\n');
    const m = parseText(text);
    expect(m.functions.map((f) => f.name)).toEqual(['f', 'g']);
    expect(m.issues.filter((i) => i.message.startsWith('unterminated'))).toEqual([]);
  });

  it('parses every branch of preprocessor conditionals', () => {
    const m = parseText('#ifdef A\nfloat f(float x) { return x; }\n#else\nfloat f(vec2 x) { return x.x; }\n#endif\n');
    expect(m.functions).toHaveLength(2);
    expect(m.conditionals).toHaveLength(1);
    expect(m.conditionals[0].branches.map((b) => b.kind)).toEqual(['ifdef', 'else', 'endif']);
  });
});

describe('parser: directives', () => {
  it('extracts includes, macros, guards and shader-toy directives', () => {
    const text = [
      '#ifndef FNC_FOO',
      '#define FNC_FOO',
      '#include "../math/const.glsl"',
      '#define SCALE 2.0 // the scale',
      '#define SQ(x) ((x) * (x))',
      '#iChannel0 "file://buffer.glsl"',
      '#iChannel0::WrapMode "Repeat"',
      '#iKeyboard',
      '// Speed of things',
      '#iUniform float u_speed = 1.0 in { 0.0, 4.0 }',
      '#iUniform color3 u_tint = color3(1.0, 0.5, 0.2)',
      '#endif',
    ].join('\n');
    const m = parseText(text);
    expect(m.includes[0]).toMatchObject({ path: '../math/const.glsl' });
    expect(m.includes[0].pathRange.start.character).toBe('#include "'.length);
    const macros = Object.fromEntries(m.macros.map((x) => [x.name, x]));
    expect(macros['FNC_FOO'].isIncludeGuard).toBe(true);
    expect(macros['SCALE'].body).toBe('2.0');
    expect(macros['SCALE'].doc?.text).toBe('the scale');
    expect(macros['SQ'].params).toEqual(['x']);
    expect(m.shadertoy.channels).toEqual([expect.objectContaining({ index: 0, source: 'file://buffer.glsl' })]);
    expect(m.shadertoy.keyboard).toBe(true);
    const speed = m.globals.find((g) => g.name === 'u_speed') as VariableSymbol;
    expect(speed.iUniform).toMatchObject({ declaredType: 'float', defaultValue: '1.0', min: '0.0', max: '4.0' });
    expect(speed.doc?.text).toBe('Speed of things');
    const tint = m.globals.find((g) => g.name === 'u_tint')!;
    expect(tint.type.name).toBe('vec3');
    expect(tint.iUniform?.defaultValue).toBe('color3(1.0, 0.5, 0.2)');
  });

  it('does not mark option macros as include guards', () => {
    const m = parseText('#ifndef RANDOM_SINLESS\n#define RANDOM_SINLESS\n#endif\n#include "x.glsl"\nfloat f() { return 1.0; }');
    expect(m.macros[0].isIncludeGuard).toBe(false);
  });

  it('records identifier references in directives', () => {
    const m = parseText('#define F(UV) random(UV)\n#ifdef GNOISE\n#endif');
    const refs = m.occurrences.filter((o) => o.role === 'directive').map((o) => o.name);
    expect(refs).toEqual(['random', 'GNOISE']);
  });

  it('computes folding regions', () => {
    const m = parseText('// a\n// b\nvoid f() {\n  x;\n}\n#ifdef A\nx\n#endif\n#include "a"\n#include "b"\n');
    const kinds = m.folding.map((f) => `${f.kind}:${f.startLine}-${f.endLine}`);
    expect(kinds).toEqual(expect.arrayContaining(['comment:0-1', 'code:2-4', 'code:5-7', 'imports:8-9']));
  });
});
