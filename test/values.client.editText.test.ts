import { describe, expect, it } from 'vitest';
import { buildReplacement, classifyChange, slotIntact, type GroupSpec } from '../client/src/values/editText';

/** Builds slots for the number literals of `src` (offsets absolute, span starts at 0). */
function slots(src: string, only?: number[]): GroupSpec {
  const out: GroupSpec['slots'] = [];
  const re = /(?<![\w.])\d+\.?\d*(?:lf|f)?/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(src))) {
    if (!only || only.includes(i)) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0], value: parseFloat(m[0]), editable: true, integer: !/[.f]/.test(m[0]) });
    }
    i++;
  }
  return { slots: out };
}

describe('buildReplacement', () => {
  it('replaces only changed components and keeps separators', () => {
    const src = 'vec3(1.0,  0.5, 0.25)';
    expect(buildReplacement(src, 0, [slots(src)], [null, 0.75, null], 2, 4)).toBe('vec3(1.0,  0.75, 0.25)');
  });

  it('keeps the original text when the value is numerically unchanged', () => {
    const src = 'x = 1.250;';
    expect(buildReplacement(src, 0, [slots(src)], [1.25], 1, 4)).toBe(src);
  });

  it('formats floats with a trailing .0 and trims zeros', () => {
    const src = 'a = 0.3;';
    expect(buildReplacement(src, 0, [slots(src)], [2], 3, 4)).toBe('a = 2.0;');
    expect(buildReplacement(src, 0, [slots(src)], [0.41], 3, 4)).toBe('a = 0.41;');
  });

  it('writes integers without a dot', () => {
    const src = 'n = 3;';
    expect(buildReplacement(src, 0, [slots(src)], [7.4], 2, 4)).toBe('n = 7;');
  });

  it('writes negatives and avoids a double minus', () => {
    const g: GroupSpec = { slots: [{ start: 3, end: 6, text: '0.5', value: 0.5, editable: true }] };
    expect(buildReplacement('0.5', 3, [g], [-0.25], 2, 4, '-')).toBe(' -0.25');
    expect(buildReplacement('0.5', 3, [g], [-0.25], 2, 4, '=')).toBe('-0.25');
  });

  it('preserves float suffixes', () => {
    const src = 'v = 1.0f;';
    expect(buildReplacement(src, 0, [slots(src)], [2.5], 1, 4)).toBe('v = 2.5f;');
  });

  it('does not touch locked components', () => {
    const src = 'vec3(t, 0.5, 1.0)';
    const g: GroupSpec = {
      slots: [
        { start: 5, end: 6, text: 't', value: NaN, editable: false },
        { start: 8, end: 11, text: '0.5', value: 0.5, editable: true },
        { start: 13, end: 16, text: '1.0', value: 1, editable: true },
      ],
    };
    expect(buildReplacement(src, 0, [g], [9, 0.6, null], 1, 4)).toBe('vec3(t, 0.6, 1.0)');
  });

  describe('splat', () => {
    const src = 'vec3(0.5)';
    const splat: GroupSpec = { slots: [{ start: 5, end: 8, text: '0.5', value: 0.5, editable: true }], splatN: 3 };

    it('stays a splat while components are equal', () => {
      expect(buildReplacement(src, 0, [splat], [0.8], 1, 4)).toBe('vec3(0.8)');
      expect(buildReplacement(src, 0, [splat], [0.8, 0.8, 0.8], 1, 4)).toBe('vec3(0.8)');
    });

    it('expands when components differ', () => {
      expect(buildReplacement(src, 0, [splat], [0.8, 0.5, 0.2], 1, 4)).toBe('vec3(0.8, 0.5, 0.2)');
      expect(buildReplacement(src, 0, [splat], [null, 0.9, null], 1, 4)).toBe('vec3(0.5, 0.9, 0.5)');
    });
  });

  it('flattened multi/palette: one value per component, in order', () => {
    const src = 'a(1.0, vec2(2.0, 3.0))';
    const g = [slots(src, [0]), slots(src, [1, 2])];
    expect(buildReplacement(src, 0, g, [5, 6, 7], 1, 4)).toBe('a(5.0, vec2(6.0, 7.0))');
  });

  it('flattened with a splat child accepts both layouts', () => {
    const src = 'p(vec3(0.5), vec3(1.0, 2.0, 3.0))';
    const splat: GroupSpec = { slots: [{ start: 7, end: 10, text: '0.5', value: 0.5, editable: true }], splatN: 3 };
    const full = slots(src, [1, 2, 3]);
    expect(buildReplacement(src, 0, [splat, full], [0.1, 0.2, 0.3, 1, 2, 3], 1, 4)).toBe('p(vec3(0.1, 0.2, 0.3), vec3(1.0, 2.0, 3.0))');
    expect(buildReplacement(src, 0, [splat, full], [0.9, 1, 2, 4], 1, 4)).toBe('p(vec3(0.9), vec3(1.0, 2.0, 4.0))');
  });

  it('respects a span that does not start at 0', () => {
    const doc = 'xx vec2(1.0, 2.0) yy';
    const span = doc.slice(3, 17);
    const g: GroupSpec = {
      slots: [
        { start: 8, end: 11, text: '1.0', value: 1, editable: true },
        { start: 13, end: 16, text: '2.0', value: 2, editable: true },
      ],
    };
    expect(buildReplacement(span, 3, [g], [3, null], 1, 4)).toBe('vec2(3.0, 2.0)');
  });
});

describe('classifyChange', () => {
  it('before: shifts', () => {
    expect(classifyChange(10, 5, 0, 2, 5)).toEqual({ kind: 'before', shift: 3 });
  });
  it('after: ignored', () => {
    expect(classifyChange(10, 5, 20, 0, 1)).toEqual({ kind: 'after' });
  });
  it('inside and touching: intersect', () => {
    expect(classifyChange(10, 5, 12, 1, 1).kind).toBe('intersect');
    expect(classifyChange(10, 5, 10, 0, 1).kind).toBe('intersect');
    expect(classifyChange(10, 5, 15, 0, 1).kind).toBe('intersect');
    expect(classifyChange(10, 5, 8, 2, 0).kind).toBe('intersect');
  });
});

describe('stale targets and precision (regressions)', () => {
  it('a stale slot never matches a longer literal that starts with it', () => {
    // target computed for `float a = 0.5;`, document now `float a = 0.55;`
    const doc = 'float a = 0.55;';
    expect(slotIntact(doc[9], doc.slice(10, 13), doc[13], '0.5')).toBe(false);
    expect(slotIntact(' ', '0.5', ';', '0.5')).toBe(true);
    expect(slotIntact('(', '-0.5', ',', '-0.5')).toBe(true);
    expect(slotIntact('x', '2', ';', '2')).toBe(false);
    expect(slotIntact('', '1.0', '', '1.0')).toBe(true);
  });
  it('a literal with more decimals than maxDecimals keeps its precision', () => {
    const g = slots('x = 0.00025;');
    expect(buildReplacement('x = 0.00025;', 0, [g], [0.00026], 5, 4)).toBe('x = 0.00026;');
  });
  it('tiny values are written with an exponent instead of 0.0', () => {
    const g = slots('eps = 0.5;');
    expect(buildReplacement('eps = 0.5;', 0, [g], [0.00001], 5, 4)).toBe('eps = 1e-5;');
    const e: GroupSpec = { slots: [{ start: 6, end: 10, text: '1e-5', value: 1e-5, editable: true }] };
    expect(buildReplacement('eps = 1e-5;', 0, [e], [2e-5], 5, 4)).toBe('eps = 2e-5;');
  });
});
