// iq cosine palettes written without c, with scalar a/b, or with a..d as variables.
import { describe, expect, it } from 'vitest';
import { buildGroups, buildReplacement, spanOf } from '../client/src/values/editText';
import type { Position, ValueTarget } from '../shared/valuesProtocol';
import { chooseWidget, flatValues } from '../webview/src/math/targets';
import { at, textOf } from './valuesServerHelpers';

function applyEdit(text: string, t: ValueTarget, values: (number | null)[], decimals: number): string {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const offsetAt = (p: Position) => lineStarts[p.line] + p.character;
  const groups = buildGroups(t, offsetAt);
  const span = spanOf(t, groups, offsetAt);
  return text.slice(0, span.start) + buildReplacement(text.slice(span.start, span.end), span.start, groups, values, decimals, 4, text[span.start - 1] ?? '') + text.slice(span.end);
}

describe('cosine palettes: more iq forms', () => {
  it('c omitted: a + b*cos(6.28318*(t+d)) -> palette with an implicit c = 1', () => {
    const { t, text } = at('void f(){ vec3 col = vec3(0.5) + vec3(0.5) * cos(6.28318 * (t + vec3(0.0, 0.3|3, 0.67))); }');
    expect(t).toMatchObject({ kind: 'palette', paletteShape: 'expression' });
    expect(textOf(text, t)!.startsWith('vec3(0.5) + vec3(0.5) * cos(')).toBe(true);
    expect(chooseWidget(t!)).toBe('palette');
    const c = t!.children![2];
    expect(c).toMatchObject({ name: 'c', implicit: true, kind: 'vec3', splat: true });
    expect(c.components[0]).toMatchObject({ value: 1, editable: false });
    expect(flatValues(t!).slice(6, 9)).toEqual([1, 1, 1]);
    // A preset (12 values) leaves the source without c and rewrites a, b, d.
    const edited = applyEdit(text, t!, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 1, 0, 0.1, 0.2], 2);
    expect(edited).toContain('vec3(0.5) + vec3(0.5) * cos(6.28318 * (t + vec3(0.0, 0.1, 0.2)))');
  });

  it('scalar a / b: 0.5 + 0.5*cos(6.28318*(c*t+d)); editing a channel writes vec3(...)', () => {
    const { t, text } = at('void f(){ vec3 col = 0.5 + 0.5 * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.|33, 0.67))); }');
    expect(t).toMatchObject({ kind: 'palette', paletteShape: 'expression' });
    expect(textOf(text, t)!.startsWith('0.5 + 0.5 * cos(')).toBe(true);
    const [a, b] = t!.children!;
    expect(a).toMatchObject({ name: 'a', kind: 'vec3', splat: true, colorish: true });
    expect(a.ctor).toBeUndefined();
    expect(b.colorish).toBe(true);
    expect(flatValues(t!).slice(0, 6)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(applyEdit(text, a, [0.8, 0.5, 0.2], 2)).toContain('vec3 col = vec3(0.8, 0.5, 0.2) + 0.5 * cos(');
    expect(applyEdit(text, a, [0.25, 0.25, 0.25], 2)).toContain('vec3 col = 0.25 + 0.5 * cos(');
    // scalar a + vector form in the same statement, iq's `t * c` order
    const r = at('vec3 col = 0.5 + 0.5*cos(6.28318*(t*vec3(1.0,1.0,1.0)+vec3(0.0,0.1,0.2)))|;');
    expect(r.t?.kind).toBe('palette');
  });

  it('scalar operands that are part of a product are not palettes', () => {
    expect(at('void f(){ vec3 col = x * 0.5 + 0.5 * cos(6.28318 * (vec3(1.0) * t + vec3(0.|3))); }').t?.kind).not.toBe('palette');
  });

  it('variables: a + b*cos(6.28318*(c*t+d)) with vec3 a..d declared from literals', () => {
    const src = [
      'void f(float t){',
      '  vec3 a = vec3(0.5, 0.5, 0.5);',
      '  vec3 b = vec3(0.5, 0.5, 0.5);',
      '  vec3 c = vec3(1.0, 1.0, 1.0);',
      '  vec3 d = vec3(0.0, 0.33, 0.67);',
      '  vec3 col = a + b * co|s(6.28318 * (c * t + d));',
      '}',
    ].join('\n');
    const { t, text } = at(src);
    expect(t).toMatchObject({ kind: 'palette', paletteShape: 'expression' });
    expect(t!.children!.map((ch) => textOf(text, ch))).toEqual(['vec3(0.5, 0.5, 0.5)', 'vec3(0.5, 0.5, 0.5)', 'vec3(1.0, 1.0, 1.0)', 'vec3(0.0, 0.33, 0.67)']);
    const edited = applyEdit(text, t!, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 1, 0, 0.1, 0.2], 2);
    expect(edited).toContain('vec3 d = vec3(0.0, 0.1, 0.2);');
    // The declarations get the palette context: a/b read as colors, c/d do not.
    const plain = src.replace('co|s', 'cos');
    expect(at(plain.replace('vec3 a = vec3(0.5,', 'vec3 a = vec3(0.|5,')).t).toMatchObject({ kind: 'vec3', colorish: true });
    expect(at(plain.replace('vec3 b = vec3(0.5,', 'vec3 b = vec3(0.|5,')).t).toMatchObject({ kind: 'vec3', colorish: true });
    expect(at(plain.replace('vec3 d = vec3(0.0,', 'vec3 d = vec3(0.|0,')).t).toMatchObject({ kind: 'vec3', colorish: false });
  });

  it('variables that are parameters (iq palette() itself) are not palettes; resolvable a/b still read as colors', () => {
    expect(at('vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * co|s(6.28318 * (c * t + d)); }').t?.kind).not.toBe('palette');
    const r = at('vec3 pal(float t, vec3 d) { vec3 a = vec3(0.5, 0.5, 0.|5); vec3 b = vec3(0.5); return a + b * cos(6.28318 * (vec3(1.0) * t + d)); }');
    expect(r.t).toMatchObject({ kind: 'vec3', colorish: true });
  });
});
