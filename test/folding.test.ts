import { describe, expect, it } from 'vitest';
import { computeFoldingRanges, computeSelectionRange } from '../server/src/features/folding';
import { cursor, parseText } from './helpers';

const fold = (t: string) => computeFoldingRanges(parseText(t));

describe('folding', () => {
  it('folds function and struct bodies leaving the closing brace visible', () => {
    const r = fold('struct S {\n  float a;\n  float b;\n};\nvoid f() {\n  int x;\n  x++;\n}\n');
    expect(r).toContainEqual({ startLine: 0, endLine: 2, kind: undefined });
    expect(r).toContainEqual({ startLine: 4, endLine: 6, kind: undefined });
  });
  it('folds comments: block and // runs', () => {
    const r = fold('/*\n doc\n*/\n// a\n// b\n// c\nfloat x;\n');
    expect(r.filter((x) => x.kind === 'comment')).toEqual([
      { startLine: 0, endLine: 2, kind: 'comment' },
      { startLine: 3, endLine: 5, kind: 'comment' },
    ]);
  });
  it('folds #if regions up to the line before #else / #endif', () => {
    const r = fold('#ifdef A\nfloat a;\nfloat b;\n#else\nfloat c;\nfloat d;\n#endif\n');
    expect(r).toContainEqual({ startLine: 0, endLine: 2, kind: 'region' });
    expect(r).toContainEqual({ startLine: 3, endLine: 5, kind: 'region' });
  });
  it('folds include runs as imports', () => {
    const r = fold('#include "a.glsl"\n#include "b.glsl"\n#include "c.glsl"\nfloat x;\n');
    expect(r).toContainEqual({ startLine: 0, endLine: 2, kind: 'imports' });
  });
  it('folds // region markers', () => {
    const r = fold('// region Foo\nfloat a;\nfloat b;\n// endregion\n');
    expect(r).toContainEqual({ startLine: 0, endLine: 3, kind: 'region' });
  });
  it('folds multi-line initializer lists', () => {
    const r = fold('const float K[3] = float[3](\n  1.0,\n  2.0,\n  3.0\n);\n');
    expect(r.some((x) => x.startLine === 0 && x.endLine === 3)).toBe(true);
  });
  it('no duplicates and survives broken code', () => {
    const r = fold('void f() {\n  if (x) {\n');
    const keys = r.map((x) => `${x.startLine}:${x.endLine}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

function chain(src: string): string[] {
  const { text, position } = cursor(src);
  const model = parseText(text);
  let sr: ReturnType<typeof computeSelectionRange> | undefined = computeSelectionRange(model, position);
  const out: string[] = [];
  while (sr) {
    out.push(text.slice(model.lines.offsetAt(sr.range.start), model.lines.offsetAt(sr.range.end)));
    sr = sr.parent;
  }
  return out;
}

describe('selection ranges', () => {
  const src = 'float g(float a) {\n  float r = mix(a, sin(ab|c), 0.5);\n  return r;\n}\n';
  const c = chain(src);
  it('expands word -> argument -> call -> statement -> block -> function -> file', () => {
    expect(c[0]).toBe('abc');
    expect(c).toContain('sin(abc)');
    expect(c).toContain('mix(a, sin(abc), 0.5)');
    expect(c).toContain('float r = mix(a, sin(abc), 0.5);');
    expect(c.some((s) => s.startsWith('{') && s.endsWith('}'))).toBe(true);
    expect(c[c.length - 2]).toMatch(/^float g\(float a\) \{/);
    expect(c[c.length - 1]).toBe(src.replace('|', ''));
  });
  it('is strictly growing', () => {
    for (let i = 1; i < c.length; i++) expect(c[i].length).toBeGreaterThan(c[i - 1].length);
  });
  it('orders call before outer call', () => {
    expect(c.indexOf('sin(abc)')).toBeLessThan(c.indexOf('mix(a, sin(abc), 0.5)'));
  });
  it('works on empty and broken files', () => {
    expect(chain('|').length).toBeGreaterThan(0);
    expect(chain('void f( {  x|').length).toBeGreaterThan(0);
  });
});
