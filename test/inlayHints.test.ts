import { describe, expect, it } from 'vitest';
import { argNamesParam, computeInlayHints, isLiteralLike, parseMode, type ParameterNamesMode } from '../server/src/features/inlayHints';
import { makeWorkspace, uri } from './helpers';

const LIB = `vec2 rot(vec2 p, float angle) { return p; }
float sq(float x) { return x; }
vec3 tint(vec3 col, float amount, float gamma, bool flip) { return col; }
`;
const MAIN = `#include "lib.glsl"
void f() {
  vec2 uv = vec2(0.);
  float amount = 1.0;
  rot(uv, 0.5);
  sq(2.0);
  tint(vec3(1.0), amount, 2.2, true);
  float s = smoothstep(0.0, 1.0, uv.x);
  float m = mix(0.0, 1.0, 0.5);
  vec3 v = vec3(1.0, 2.0, 3.0);
  rot(uv, sq(uv.x));
}
`;

type R = { start: { line: number; character: number }; end: { line: number; character: number } };

function hints(mode: ParameterNamesMode, range?: R, src = MAIN) {
  const { ws } = makeWorkspace({ 'main.glsl': src, 'lib.glsl': LIB });
  const lines = src.split('\n').length;
  return computeInlayHints(
    { workspace: ws },
    { textDocument: { uri: uri('main.glsl') }, range: range ?? { start: { line: 0, character: 0 }, end: { line: lines, character: 0 } } },
    { mode },
  ).map((h) => `${h.position.line}:${typeof h.label === 'string' ? h.label : ''}`);
}

describe('inlayHints', () => {
  it('labels literals by default and skips single-param calls', () => {
    const h = hints('literals');
    expect(h).toContain('4:angle:');
    expect(h.some((x) => x.startsWith('5:'))).toBe(false);
    expect(h).toContain('6:gamma:');
    expect(h).toContain('6:flip:');
    expect(h).toContain('6:col:'); // constructor-like argument
    expect(h).not.toContain('6:amount:'); // identifier, and named like the param
  });

  it('skips obvious builtin names but keeps meaningful ones', () => {
    const h = hints('literals');
    expect(h.filter((x) => x.startsWith('7:'))).toEqual(['7:edge0:', '7:edge1:']);
    expect(h.some((x) => x.startsWith('8:'))).toBe(false);
  });

  it('never hints builtin constructors', () => {
    expect(hints('all').some((x) => x.startsWith('9:'))).toBe(false);
  });

  it("'all' also labels identifiers and expressions", () => {
    const h = hints('all');
    expect(h).toContain('4:p:');
    expect(h).toContain('10:angle:');
  });

  it("'none' emits nothing and legacy booleans map", () => {
    expect(hints('none')).toEqual([]);
    expect(parseMode(true)).toBe('literals');
    expect(parseMode(false)).toBe('none');
    expect(parseMode('all')).toBe('all');
    expect(parseMode(undefined)).toBe('literals');
  });

  it('only computes hints inside the requested range', () => {
    const h = hints('literals', { start: { line: 4, character: 0 }, end: { line: 4, character: 20 } });
    expect(h).toEqual(['4:angle:']);
  });

  it('is robust to half-typed calls', () => {
    expect(() => hints('all', undefined, '#include "lib.glsl"\nvoid f() { rot(1.0, \n')).not.toThrow();
  });

  it('helpers', () => {
    expect(isLiteralLike('1.0')).toBe(true);
    expect(isLiteralLike('-.5')).toBe(true);
    expect(isLiteralLike('vec2(1.0)')).toBe(true);
    expect(isLiteralLike('a + 1.0')).toBe(false);
    expect(isLiteralLike('uv')).toBe(false);
    expect(argNamesParam('p.uv', 'uv')).toBe(true);
    expect(argNamesParam('fragCoord', 'coord')).toBe(true);
    expect(argNamesParam('pos', 'coord')).toBe(false);
  });
});
