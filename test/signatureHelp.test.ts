import { describe, expect, it } from 'vitest';
import { computeSignatureHelp } from '../server/src/features/signatureHelp';
import { cursor, makeWorkspace, uri } from './helpers';

const LIB = `// Rotates p by a radians.
// @param p point
// @param a angle in radians
vec2 rot(vec2 p, float a) { return p; }
// Three-arg variant.
vec2 rot(vec2 p, float a, vec2 c) { return p; }
struct Mat { float rough; vec3 color; };
#define SAT(x) clamp(x, 0.0, 1.0)
`;
const LYGIA =
  '/*\ncontributors: X\ndescription: Gradient Noise\nuse: gnoise(<float> x)\nlicense: MIT\n*/\n#ifndef FNC_GNOISE\n#define FNC_GNOISE\nfloat gnoise(float x) { return x; }\nfloat gnoise(vec2 st) { return st.x; }\n#endif\n';

function sig(src: string, context?: any) {
  const c = cursor(src);
  const { ws } = makeWorkspace({ 'main.glsl': c.text, 'lib.glsl': LIB, 'lygia/gnoise.glsl': LYGIA });
  return computeSignatureHelp({ workspace: ws }, { textDocument: { uri: uri('main.glsl') }, position: c.position, context });
}
const HEAD = '#include "lib.glsl"\n#include "lygia/gnoise.glsl"\nvoid f() { vec2 uv = vec2(0.); float t = 1.0;\n';

type Help = NonNullable<ReturnType<typeof sig>>;
function paramText(h: Help, i: number) {
  const s = h.signatures[h.activeSignature ?? 0];
  const p = s.parameters![i].label as [number, number];
  return s.label.slice(p[0], p[1]);
}
const md = (x: unknown) => (x as { value: string }).value;

describe('signatureHelp', () => {
  it('lists all overloads with offset labels, docs and param docs', () => {
    const h = sig(HEAD + 'rot(|')!;
    expect(h.signatures.map((s) => s.label)).toEqual(['vec2 rot(vec2 p, float a)', 'vec2 rot(vec2 p, float a, vec2 c)']);
    expect(paramText(h, 1)).toBe('float a');
    expect(md(h.signatures[0].documentation)).toContain('Rotates p by a radians');
    expect(md(h.signatures[0].parameters![1].documentation)).toContain('angle');
    expect(h.activeParameter).toBe(0);
  });

  it('tracks the active parameter by commas and ignores nested ones', () => {
    expect(sig(HEAD + 'rot(uv, |')!.activeParameter).toBe(1);
    expect(sig(HEAD + 'rot(vec2(1., 2.), |')!.activeParameter).toBe(1);
    const inner = sig(HEAD + 'rot(vec2(1., |')!;
    expect(inner.signatures[0].label).toContain('vec2(');
    expect(inner.activeParameter).toBe(1);
  });

  it('chooses the overload by argument count', () => {
    expect(sig(HEAD + 'rot(uv, t, uv|)')!.activeSignature).toBe(1);
    expect(sig(HEAD + 'rot(uv, t|)')!.activeSignature).toBe(0);
    expect(sig(HEAD + 'rot(uv, t, |')!.activeSignature).toBe(1);
  });

  it('chooses by argument types when the count is ambiguous', () => {
    const h = sig(HEAD + 'gnoise(uv|')!;
    expect(h.signatures).toHaveLength(2);
    expect(h.signatures[h.activeSignature!].label).toBe('float gnoise(vec2 st)');
    const g = sig(HEAD + 'gnoise(1.0|')!;
    expect(g.signatures[g.activeSignature!].label).toBe('float gnoise(float x)');
  });

  it('renders LYGIA yaml docs', () => {
    expect(md(sig(HEAD + 'gnoise(|')!.signatures[0].documentation)).toContain('Gradient Noise');
  });

  it('works on unbalanced and half-typed code', () => {
    expect(sig(HEAD + 'float x = rot((uv + vec2(1.0, |')!.signatures.length).toBeGreaterThan(0);
    expect(sig(HEAD + 'rot(uv, t\n  vec2 q = 1;|')).toBeNull();
  });

  it('shows constructor forms', () => {
    const h = sig(HEAD + 'vec3(1.0, |')!;
    const labels = h.signatures.map((s) => s.label);
    expect(labels).toContain('vec3(float s)');
    expect(labels).toContain('vec3(float x, float y, float z)');
    expect(labels).toContain('vec3(vec2 xy, float z)');
    expect(labels).toContain('vec3(vec4 v)');
    expect(h.signatures[h.activeSignature!].label).toBe('vec3(float x, float y, float z)');
    expect(h.activeParameter).toBe(1);
    expect(sig(HEAD + 'mat2(|')!.signatures.map((s) => s.label)).toContain('mat2(vec2 col0, vec2 col1)');
  });

  it('uses struct fields as constructor parameters', () => {
    const h = sig(HEAD + 'Mat(0.5, |')!;
    expect(h.signatures[0].label).toBe('Mat(float rough, vec3 color)');
    expect(h.activeParameter).toBe(1);
  });

  it('handles function-like macros and calls inside macro args', () => {
    expect(sig(HEAD + 'SAT(|')!.signatures[0].label).toBe('SAT(x)');
    expect(sig(HEAD + 'SAT(rot(uv, |')!.signatures[0].label).toContain('rot');
  });

  it('covers builtins', () => {
    const h = sig(HEAD + 'mix(|')!;
    expect(h.signatures[0].label).toContain('mix(');
  });

  it('keeps the signature on retrigger when still as good', () => {
    const first = sig(HEAD + 'rot(uv, t, |')!;
    const again = sig(HEAD + 'rot(uv, t, |', { triggerKind: 2, isRetrigger: true, activeSignatureHelp: first })!;
    expect(again.activeSignature).toBe(1);
  });

  it('returns null outside calls', () => {
    expect(sig(HEAD + 'float z = 1.0;|')).toBeNull();
  });

  it('is fast', () => {
    const t0 = performance.now();
    sig(HEAD + 'gnoise(uv, |');
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
