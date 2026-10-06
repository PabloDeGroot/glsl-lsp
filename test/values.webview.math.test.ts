import { describe, expect, it } from 'vitest';
import { hsvToRgb, luminance, parseCssColor, parseHex, rgbToHex, rgbToHsv, splitHdr, withAlpha, cssRgb } from '../webview/src/math/color';
import {
  DEFAULT_VIEW,
  DEG,
  discToSphere,
  fromView,
  len,
  normalize,
  rotateAround,
  snapAngles,
  snapDiagonal,
  toAngles,
  toView,
  type V3,
} from '../webview/src/math/vec';
import { evalPalette, flattenPalette, paletteFromFlat, PALETTE_PRESETS } from '../webview/src/math/palette';
import {
  extendRange,
  floatRange,
  fromFraction,
  modifierFactor,
  parseNumber,
  previewDecimals,
  shownDecimals,
  minimalDecimals,
  displayDecimals,
  scrubDecimals,
  scrubStep,
  stepsFor,
  ticks,
  toFraction,
  vec2Range,
  zoomRange,
} from '../webview/src/math/range';
import { applyValues, chooseWidget, expandedValues, flatValues, refKey, sameRef, typeLabel, valuesMatch, vecMode } from '../webview/src/math/targets';
import type { ValueComponent, ValueKind, ValueTarget } from '../shared/valuesProtocol';

const close = (a: number[], b: number[], eps = 1e-6) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => expect(Math.abs(x - b[i])).toBeLessThan(eps));
};

// ---------------------------------------------------------------- fixtures

let col = 0;
function comp(value: number, text = String(value), editable = true, integer = false): ValueComponent {
  const c = col++;
  return { range: { start: { line: 0, character: c }, end: { line: 0, character: c + text.length } }, value, text, editable, integer };
}

function target(kind: ValueKind, comps: ValueComponent[], extra: Partial<ValueTarget> = {}): ValueTarget {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } };
  return {
    id: `${kind}:0:0`,
    kind,
    uri: 'file:///a.glsl',
    version: 1,
    declKind: 'local',
    snippet: kind,
    anchor: { uri: 'file:///a.glsl', kind, fingerprint: '', line: 0, character: 0, ordinal: 0 },
    range,
    components: comps,
    colorish: false,
    ...extra,
  };
}

const vec3 = (a: number, b: number, c: number, extra: Partial<ValueTarget> = {}) => target('vec3', [comp(a), comp(b), comp(c)], { ctor: 'vec3', ...extra });

// ---------------------------------------------------------------- color

describe('color', () => {
  it('converts hsv <-> rgb', () => {
    close(hsvToRgb(0, 1, 1), [1, 0, 0]);
    close(hsvToRgb(120, 1, 1), [0, 1, 0]);
    close(hsvToRgb(240, 1, 0.5), [0, 0, 0.5]);
    close(hsvToRgb(360, 1, 1), [1, 0, 0]);
    const hsv = rgbToHsv([0.9, 0.4, 0.2]);
    close(hsvToRgb(hsv.h, hsv.s, hsv.v), [0.9, 0.4, 0.2]);
    expect(hsv.h).toBeCloseTo(17.14, 1);
  });

  it('keeps hue/saturation stable for greys and black', () => {
    const prev = { h: 200, s: 0.7, v: 0.5 };
    expect(rgbToHsv([0.5, 0.5, 0.5], prev).h).toBe(200);
    const black = rgbToHsv([0, 0, 0], prev);
    expect(black.h).toBe(200);
    expect(black.s).toBe(0.7);
    expect(black.v).toBe(0);
  });

  it('formats and parses hex', () => {
    expect(rgbToHex([0.9, 0.4, 0.2])).toBe('#E66633');
    expect(rgbToHex([1, 1, 1], 0.5)).toBe('#FFFFFF80');
    expect(rgbToHex([2, -1, 0.5])).toBe('#FF0080');
    close(parseHex('#f00')!.rgb, [1, 0, 0]);
    close(parseHex('00ff00')!.rgb, [0, 1, 0]);
    const p = parseHex('#0000FF80')!;
    close(p.rgb, [0, 0, 1]);
    expect(p.alpha).toBeCloseTo(128 / 255);
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('zzz')).toBeNull();
    expect(parseHex('#abcd')!.alpha).toBeCloseTo(0xdd / 255);
  });

  it('splits HDR colors into chroma and intensity', () => {
    const { chroma, k } = splitHdr([2.4, 1.2, 0.3]);
    expect(k).toBe(2.4);
    close(chroma, [1, 0.5, 0.125]);
    expect(splitHdr([0.5, 0.2, 1]).k).toBe(1);
  });

  it('parses css colors and applies alpha', () => {
    expect(parseCssColor('#cccccc')).toEqual({ r: 204, g: 204, b: 204, a: 1 });
    expect(parseCssColor('rgba(90, 93, 94, 0.31)')).toEqual({ r: 90, g: 93, b: 94, a: 0.31 });
    expect(parseCssColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseCssColor('red')).toBeNull();
    expect(withAlpha('#ffffff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
    expect(withAlpha('rgba(0, 0, 0, 0.5)', 0.5)).toBe('rgba(0, 0, 0, 0.25)');
    expect(withAlpha('red', 0.5)).toBe('red');
    expect(cssRgb([1, 0.5, 0])).toBe('rgb(255, 128, 0)');
    expect(cssRgb([1, 0.5, 0], 0.25)).toBe('rgba(255, 128, 0, 0.25)');
  });

  it('computes luminance', () => {
    expect(luminance([1, 1, 1])).toBeCloseTo(1);
    expect(luminance([0, 0, 0])).toBe(0);
  });
});

// ---------------------------------------------------------------- vectors

describe('vec', () => {
  it('round-trips the view transform', () => {
    const v: V3 = [0.3, 0.8, 0.52];
    close(fromView(toView(v, DEFAULT_VIEW), DEFAULT_VIEW), v);
    // identity view leaves vectors untouched
    close(toView(v, { yaw: 0, pitch: 0 }), v);
  });

  it('maps the disc to the sphere with wrap-around onto the back', () => {
    close(discToSphere(0, 0, true), [0, 0, 1]);
    close(discToSphere(0, 0, false), [0, 0, -1]);
    close(discToSphere(1, 0, true), [1, 0, 0]);
    const inside = discToSphere(0.6, 0, true);
    close(inside, [0.6, 0, 0.8]);
    const wrapped = discToSphere(1.4, 0, true);
    close(wrapped, [0.6, 0, -0.8]);
    close(discToSphere(3, 0, true), [0, 0, -1]);
    for (const p of [discToSphere(0.3, -0.4, true), discToSphere(1.7, 0.2, false)]) expect(len(p)).toBeCloseTo(1);
  });

  it('rotates around an axis', () => {
    close(rotateAround([1, 0, 0], [0, 0, 1], Math.PI / 2), [0, 1, 0]);
    close(rotateAround([0, 0, 1], [0, 1, 0], Math.PI / 2), [1, 0, 0]);
  });

  it('snaps angles and diagonals', () => {
    const a = toAngles(snapAngles([0.3, 0.05, 1], 15));
    expect(Math.round(a.az / DEG) % 15).toBe(0);
    expect(Math.round(a.el / DEG) % 15).toBe(0);
    close(snapDiagonal([0.9, 0.1, 0.05]), [1, 0, 0]);
    close(snapDiagonal([0.7, 0.68, 0]), normalize([1, 1, 0]));
  });

  it('normalizes with a fallback for zero', () => {
    close(normalize([0, 0, 0]), [0, 0, 1]);
    close(normalize([3, 0, 4]), [0.6, 0, 0.8]);
  });
});

// ---------------------------------------------------------------- palette

describe('palette', () => {
  it('evaluates iq cosine palettes', () => {
    const p = PALETTE_PRESETS[0].palette;
    close(evalPalette(p, 0), [1, 0.5 + 0.5 * Math.cos(2 * Math.PI * 0.33), 0.5 + 0.5 * Math.cos(2 * Math.PI * 0.67)]);
    close(flattenPalette(paletteFromFlat(flattenPalette(p))), flattenPalette(p));
    expect(flattenPalette(p)).toHaveLength(12);
  });
});

// ---------------------------------------------------------------- ranges

describe('range', () => {
  it('resolves float ranges by priority', () => {
    expect(floatRange(1.25, { declaredType: 'float', min: 0, max: 4 }, { range: { min: 0, max: 2 } })).toEqual({ min: 0, max: 4, source: 'uniform' });
    expect(floatRange(1.25, undefined, { range: { min: -2, max: 2 } })).toEqual({ min: -2, max: 2, source: 'user' });
    expect(floatRange(2.5)).toEqual({ min: 0, max: 5, source: 'auto' });
    expect(floatRange(1)).toEqual({ min: 0, max: 2, source: 'auto' });
    expect(floatRange(0.5, undefined, { range: { min: 3, max: 1 } }).source).toBe('auto');
  });

  it('resolves vec2 ranges', () => {
    expect(vec2Range(0.25, 0.5)).toEqual({ min: 0, max: 1, source: 'auto' });
    expect(vec2Range(-0.5, 2)).toEqual({ min: -5, max: 5, source: 'auto' });
    expect(vec2Range(3, 2)).toEqual({ min: 0, max: 10, source: 'auto' });
    // a uv-like 1.0 is not pinned to the edge of the pad
    expect(vec2Range(1, 1)).toEqual({ min: 0, max: 2, source: 'auto' });
  });

  it('extends and zooms ranges', () => {
    expect(extendRange({ min: 0, max: 1 }, 0.5)).toEqual({ min: 0, max: 1 });
    expect(extendRange({ min: 0, max: 1 }, 2.5)).toEqual({ min: 0, max: 5 });
    expect(extendRange({ min: 0, max: 1 }, -0.5)).toEqual({ min: -1, max: 1 });
    expect(zoomRange({ min: -1, max: 1 }, 2)).toEqual({ min: -2, max: 2 });
    expect(zoomRange({ min: 2, max: 4 }, 0.5)).toEqual({ min: 2.5, max: 3.5 });
  });

  it('derives steps and decimals', () => {
    expect(stepsFor({ min: 0, max: 1 })).toEqual({ drag: 0.001, key: 0.01, decimals: 3 });
    expect(stepsFor({ min: 0, max: 4 }, { uniformStep: 0.5 })).toEqual({ drag: 0.5, key: 0.5, decimals: 1 });
    expect(stepsFor({ min: 0, max: 10 }, { integer: true })).toEqual({ drag: 1, key: 1, decimals: 0 });
  });

  it('maps fractions and ticks', () => {
    expect(toFraction(0.25, { min: 0, max: 1 })).toBe(0.25);
    expect(toFraction(5, { min: 0, max: 1 })).toBe(1);
    expect(fromFraction(0.5, { min: -1, max: 1 })).toBe(0);
    expect(ticks({ min: 0, max: 1 })).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('handles modifiers and scrubbing', () => {
    expect(modifierFactor({ shiftKey: true, altKey: false })).toBe(10);
    expect(modifierFactor({ shiftKey: false, altKey: true })).toBe(0.1);
    expect(scrubStep('0.25', false, { shiftKey: false, altKey: false })).toBe(0.01);
    expect(scrubStep('3', true, { shiftKey: true, altKey: false })).toBe(10);
    expect(scrubStep('3', true, { shiftKey: false, altKey: true })).toBe(1);
    expect(scrubDecimals('0.25', 0.001)).toBe(3);
    expect(scrubDecimals('1.0', 0.1)).toBe(1);
    expect(scrubDecimals('3', 1, true)).toBe(0);
    expect(previewDecimals('1.250', false, false)).toBe(3);
    // the literal's own precision, the same for floats and vector components (list == widget inputs)
    expect(previewDecimals('1.0', false, false)).toBe(1);
    expect(previewDecimals('0.1', false, true)).toBe(1);
    expect(previewDecimals('1.25', false, false)).toBe(2);
    expect(previewDecimals('0.8745', false, true)).toBe(4);
    expect(shownDecimals(0.51, 1)).toBe(2);
    expect(shownDecimals(0.5, 3)).toBe(3);
    expect(minimalDecimals(2)).toBe(0);
    expect(displayDecimals('1e-3')).toBe(3);
    expect(previewDecimals('3', true, false)).toBe(0);
  });

  it('parses typed numbers', () => {
    expect(parseNumber('1.')).toBe(1);
    expect(parseNumber('.5')).toBe(0.5);
    expect(parseNumber('-0.25')).toBe(-0.25);
    expect(parseNumber('1e-3')).toBe(0.001);
    expect(parseNumber('2.5f')).toBe(2.5);
    expect(parseNumber('0,5')).toBe(0.5);
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });
});

// ---------------------------------------------------------------- targets

describe('targets', () => {
  it('chooses widgets', () => {
    expect(chooseWidget(target('float', [comp(1)]))).toBe('slider');
    expect(chooseWidget(target('vec2', [comp(1), comp(2)]))).toBe('trackpad');
    expect(chooseWidget(vec3(1, 0, 0, { colorish: true }))).toBe('color');
    expect(chooseWidget(vec3(1, 0, 0))).toBe('vector');
    expect(chooseWidget(vec3(1, 0, 0, { colorish: true }), { mode: 'vector' })).toBe('vector');
    expect(chooseWidget(target('vec3', [comp(NaN, 't', false), comp(1), comp(2)]))).toBe('stack');
    expect(chooseWidget(target('vec2', [comp(1, '1', true, true), comp(2)]))).toBe('stack');
    expect(chooseWidget(target('multi', [], { children: [] }))).toBe('multi');
    const pal = target('palette', [], { children: [vec3(0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5), vec3(1, 1, 1), vec3(0, 0.33, 0.67)] });
    expect(chooseWidget(pal)).toBe('palette');
    expect(vecMode(vec3(1, 1, 1, { colorish: true }), undefined)).toBe('color');
  });

  it('expands splats and flattens children', () => {
    const splat = target('vec3', [comp(0.5)], { splat: true, ctor: 'vec3' });
    expect(expandedValues(splat)).toEqual([0.5, 0.5, 0.5]);
    const pal = target('palette', [], { children: [vec3(1, 2, 3), vec3(4, 5, 6), splat, vec3(7, 8, 9)] });
    expect(flatValues(pal)).toEqual([1, 2, 3, 4, 5, 6, 0.5, 0.5, 0.5, 7, 8, 9]);
    expect(expandedValues(target('vec3', [comp(NaN, 't', false), comp(1), comp(2)]))).toEqual([NaN, 1, 2]);
  });

  it('applies optimistic values', () => {
    const t = vec3(0.1, 0.2, 0.3);
    const next = applyValues(t, [0.5, null, 0.7]);
    expect(next.components.map((c) => c.value)).toEqual([0.5, 0.2, 0.7]);
    expect(t.components[0].value).toBe(0.1); // immutable

    const splat = target('vec3', [comp(0.5)], { splat: true });
    expect(applyValues(splat, [0.6, 0.6, 0.6]).components).toHaveLength(1);
    const exp = applyValues(splat, [0.6, 0.5, 0.5]);
    expect(exp.splat).toBe(false);
    expect(exp.components.map((c) => c.value)).toEqual([0.6, 0.5, 0.5]);

    const locked = target('vec3', [comp(NaN, 't', false), comp(1), comp(2)]);
    expect(applyValues(locked, [9, 3, 4]).components.map((c) => c.value)).toEqual([NaN, 3, 4]);

    const pal = target('palette', [], { children: [vec3(1, 2, 3), vec3(4, 5, 6), vec3(7, 8, 9), vec3(0, 0, 0)] });
    const np = applyValues(pal, [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
    expect(flatValues(np)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
  });

  it('matches values after rounding', () => {
    const t = vec3(0.123, 0.5, 1);
    expect(valuesMatch(t, [0.1234, null, 1], 3)).toBe(true);
    expect(valuesMatch(t, [0.125, null, 1], 3)).toBe(false);
  });

  it('builds keys and labels', () => {
    expect(refKey({ rowId: 'cursor' })).toBe('cursor');
    expect(refKey({ rowId: 'p_1', childIndex: 2 })).toBe('p_1#2');
    expect(sameRef({ rowId: 'a' }, { rowId: 'a' })).toBe(true);
    expect(sameRef({ rowId: 'a' }, { rowId: 'a', childIndex: 0 })).toBe(false);
    expect(typeLabel(target('float', [comp(1)], { uniform: { declaredType: 'float' } }))).toBe('float');
    expect(typeLabel(target('multi', [], { children: [target('float', [comp(1)]), target('float', [comp(2)])] }))).toBe('2 values');
    expect(typeLabel(vec3(1, 1, 1, { ctor: 'color3' }))).toBe('color3');
  });
});
