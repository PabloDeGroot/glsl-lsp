import { describe, expect, it } from 'vitest';
import { levenshtein, similarity } from '../server/src/features/values/anchors';
import { anchorAt, resolve, textOf } from './valuesServerHelpers';

function res(text: string, anchor: Parameters<typeof resolve>[1][number]) {
  return resolve(text, [anchor]).anchors![0];
}

describe('values: anchors (declaration)', () => {
  const base = 'void f(){\n  float r = 0.|25;\n  float s = 1.0;\n}\n';
  it('survives edits above and value changes', () => {
    const { anchor } = anchorAt(base);
    expect(anchor).toMatchObject({ declName: 'r', declKind: 'local', functionName: 'f', line: 1 });
    const edited = '// a\n// b\n// c\nvoid f(){\n  float r = 0.9;\n  float s = 1.0;\n}\n';
    const r = res(edited, anchor);
    expect(r.match).toBe('declaration');
    expect(r.target!.components[0].value).toBe(0.9);
    expect(r.anchor).toMatchObject({ line: 4, declName: 'r' });
    expect(textOf(edited, r.target)).toBe('0.9');
  });
  it('survives the declaration being rewritten (different line text)', () => {
    const { anchor } = anchorAt(base);
    const r = res('void f(){\n  const float r = 3.5; // renamed type qualifiers\n}\n', anchor);
    expect(r.match).toBe('declaration');
    expect(r.target!.declKind).toBe('const');
  });
  it('local names are scoped to their function', () => {
    const { anchor } = anchorAt('void a(){ float r = 1.0; }\nvoid b(){\n float r = |2.0;\n}\n');
    expect(anchor.functionName).toBe('b');
    const moved = 'void b(){ float r = 5.0; }\nvoid a(){ float r = 1.0; }\n';
    const r = res(moved, anchor);
    expect(r.match).toBe('declaration');
    expect(r.target!.components[0].value).toBe(5);
    expect(r.target!.functionName).toBe('b');
  });
  it('chooses the declaration nearest the stored line', () => {
    const { anchor } = anchorAt('float r = 1.|0;\nvoid f(){}\nfloat pad;\nfloat k = 2.0;\n');
    const r = res('float k = 1.0;\n\n\n\n\nfloat k = 3.0;\n', { ...anchor, declName: 'k', declKind: 'global', line: 5 });
    expect(r.target!.components[0].value).toBe(3);
  });
  it('#iUniform and #define anchors', () => {
    const u = anchorAt('#iUniform float u_speed = 1.|0 in { 0.0, 4.0 }\n').anchor;
    const moved = '\n\n#iUniform float u_speed = 2.5 in { 0.0, 8.0 }\n';
    const r = res(moved, u);
    expect(r.match).toBe('declaration');
    expect(r.target!.components[0].value).toBe(2.5);
    expect(r.target!.uniform).toMatchObject({ max: 8 });
    const d = anchorAt('#define SPEED 1.|5\n').anchor;
    expect(res('// x\n#define SPEED 9.5\n', d)).toMatchObject({ match: 'declaration' });
    expect(res('// x\n#define OTHER 9.5\n', d).match).toBe('none');
  });
  it('a deleted #iUniform goes stale instead of jumping to a similar neighbour', () => {
    const src = '#iUniform float u_speed = 1.|0 in { 0.0, 4.0 }\n#iUniform float u_zoom = 1.0 in { 0.25, 3.0 }\n';
    const u = anchorAt(src).anchor;
    const r = res('#iUniform float u_zoom = 1.0 in { 0.25, 3.0 }\n', u);
    expect(r.match).toBe('none');
    expect(r.target).toBeNull();
  });
  it('a deleted local does not hijack another local with the same line shape', () => {
    const { anchor } = anchorAt('void f(){\n  float r = 0.|25;\n  float s = 0.5;\n}\n');
    const r = res('void f(){\n  float s = 0.5;\n}\n', anchor);
    expect(r.target?.name).not.toBe('s');
  });
  it('a vec declaration', () => {
    const a = anchorAt('void f(){ vec3 col = vec3(1.0, |0.5, 0.2); }').anchor;
    const r = res('\nvoid f(){\n  vec3 col = vec3(0.0, 0.1, 0.2);\n}', a);
    expect(r.match).toBe('declaration');
    expect(r.target!.kind).toBe('vec3');
    expect(r.target!.range.start.line).toBe(2);
  });
  it('kind changes make the declaration stale', () => {
    const { anchor } = anchorAt('float r = 0.|25;\n');
    const r = res('vec2 r = vec2(0.25, 0.5);\n', anchor);
    expect(r.match).toBe('none');
    expect(r.target).toBeNull();
    expect(r.anchor).toEqual(anchor);
  });
  it('a plain assignment is not mistaken for the declaration', () => {
    const { anchor } = anchorAt('void f(){ float r = 0.|25; }');
    // the declaration is gone, only a reassignment remains; fingerprint differs too
    const r = res('void f(){ float q; r = 0.3 + z; }', anchor);
    expect(r.match).not.toBe('declaration');
  });
});

describe('values: anchors (fingerprint / fuzzy)', () => {
  it('assignment found by exact fingerprint after moving', () => {
    const { anchor } = anchorAt('void f(){\n  col = vec3(0.1, |0.2, 0.3);\n}\n');
    expect(anchor.declName).toBeUndefined();
    const text = 'void f(){\n  float z;\n  float zz;\n  col = vec3(0.7, 0.8, 0.9);\n}\n';
    const r = res(text, anchor);
    expect(r.match).toBe('fingerprint');
    expect(r.target!.components.map((c) => c.value)).toEqual([0.7, 0.8, 0.9]);
    expect(r.anchor.line).toBe(3);
  });
  it('same fingerprint on two lines: same text and context win, not the nearest line', () => {
    const { anchor } = anchorAt('void f(){\n  a = 1.0;\n  b = 2.0;\n  c = 0.|5;\n}\n');
    // the pinned statement moved 6 lines down; an identical-shape line now sits on the stored line
    const text = 'void f(){\n  a = 1.0;\n  b = 2.0;\n  c = 0.9;\n  q = 1.0;\n  r = 1.0;\n  s = 1.0;\n  t = 1.0;\n  b = 2.0;\n  c = 0.5;\n}\n';
    const r = res(text, anchor);
    expect(r.target!.components[0].value).toBe(0.5);
    expect(r.anchor.line).toBe(9);
  });
  it('ambiguous look-alike lines go stale instead of picking the nearest', () => {
    const { anchor } = anchorAt('void f(){\n  a = 1.0;\n  b = 2.0;\n  c = 0.|5;\n}\n');
    const text = 'void f(){\n  x = 1.0;\n  c = 0.1;\n  y = 1.0;\n  z = 1.0;\n  c = 0.2;\n  w = 1.0;\n}\n';
    expect(res(text, anchor).match).toBe('none');
  });
  it('ordinal picks the n-th literal on the line', () => {
    const a = anchorAt('void f(){ y = x + 0.5 * 0.|25; }').anchor;
    expect(a.ordinal).toBe(1);
    const r = res('\nvoid f(){ y = x + 0.1 * 0.2; }', a);
    // two literals on the line (statement multi): the float of ordinal 1 is returned
    expect(r.target!.components[0].value).toBe(0.2);
  });
  it('ordinal is clamped when the line lost literals', () => {
    const a = anchorAt('void f(){ y = x + 0.5 * 0.|25; }').anchor;
    const r = res('void f(){ y = x + 0.5; }', a);
    expect(r.target!.components[0].value).toBe(0.5);
  });
  it('fuzzy match when the line text changed a little', () => {
    const a = anchorAt('void f(){\n  result = mix(base, other, 0.|25) * strength;\n}\n').anchor;
    const r = res('void f(){\n  result = mix(base2, other, 0.9) * strength;\n}\n', a);
    expect(r.match).toBe('fuzzy');
    expect(r.target!.components[0].value).toBe(0.9);
  });
  it('fuzzy match is bounded to +-200 lines', () => {
    const a = anchorAt('void f(){\n  result = mix(base, other, 0.|25) * strength;\n}\n').anchor;
    const text = '\n'.repeat(400) + 'void f(){\n  result = mix(base2, other, 0.9) * strength;\n}\n';
    expect(res(text, a).match).toBe('none');
  });
  it('dissimilar lines do not match', () => {
    const a = anchorAt('void f(){\n  result = mix(base, other, 0.|25) * strength;\n}\n').anchor;
    expect(res('void f(){\n  q = 0.25;\n}\n', a).match).toBe('none');
  });
  it('removed target -> none and anchor unchanged', () => {
    const a = anchorAt('void f(){\n  col = vec3(0.1, |0.2, 0.3);\n}\n').anchor;
    const r = res('void f(){}\n', a);
    expect(r).toMatchObject({ target: null, match: 'none' });
    expect(r.anchor).toEqual(a);
  });
  it('multi anchors', () => {
    const t = anchorAt('void f(){\n  s = smoothstep(0.1, 0.25, d|);\n}\n');
    expect(t.target.kind).toBe('multi');
    const r = res('// moved\nvoid f(){\n  float z;\n  s = smoothstep(0.5, 0.75, d);\n}\n', t.anchor);
    expect(r.match).toBe('fingerprint');
    expect(r.target!.kind).toBe('multi');
    expect(r.target!.children!.map((c) => c.components[0].value)).toEqual([0.5, 0.75]);
  });
  it('multi anchors with a declaration inside a define', () => {
    const t = anchorAt('#define OFFSET| vec2(1.0, 2.0) * 0.5\n');
    expect(t.target.kind).toBe('multi');
    expect(t.anchor).toMatchObject({ declName: 'OFFSET', declKind: 'define' });
    const r = res('\n#define OFFSET vec2(3.0, 4.0) * 0.1\n', t.anchor);
    expect(r.match).toBe('declaration');
    expect(r.target!.children).toHaveLength(2);
  });
  it('palette anchors', () => {
    const t = anchorAt('void f(){ vec3 c = palette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.|33, 0.67)); }');
    expect(t.target.kind).toBe('palette');
    expect(t.anchor).toMatchObject({ declName: 'c', declKind: 'local' });
    const r = res('\n\nvoid f(){ vec3 c = palette(t, vec3(0.1), vec3(0.2), vec3(0.3), vec3(0.4)); }', t.anchor);
    expect(r.target!.kind).toBe('palette');
    expect(r.match).toBe('declaration');
  });
  it('request with only anchors has no cursor; many anchors keep order', () => {
    const text = 'float a = 1.0;\nfloat b = 2.0;\n';
    const a = anchorAt('float a = 1.|0;\nfloat b = 2.0;\n').anchor;
    const b = anchorAt('float a = 1.0;\nfloat b = 2.|0;\n').anchor;
    const out = resolve(text, [b, a]);
    expect(out.cursor).toBeUndefined();
    expect(out.anchors!.map((x) => x.target!.name)).toEqual(['b', 'a']);
  });
});

describe('values: string similarity', () => {
  it('levenshtein / similarity', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('', '')).toBe(1);
    expect(similarity('abcd', 'abce')).toBeCloseTo(0.75);
  });
});
