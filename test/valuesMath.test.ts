import { describe, expect, it } from 'vitest';
import {
  decimalsForStep,
  formatDisplay,
  formatFloat,
  formatInt,
  lineFingerprint,
  literalDecimals,
  smartRange,
  snap,
  stepForLiteral,
  stepForRange,
} from '../shared/valuesMath';

describe('values number formatting', () => {
  it('counts literal decimals', () => {
    expect(literalDecimals('1.250')).toBe(3);
    expect(literalDecimals('2.')).toBe(0);
    expect(literalDecimals('3')).toBe(0);
    expect(literalDecimals('1e-3')).toBe(3);
    expect(literalDecimals('0.5f')).toBe(1);
  });
  it('derives nudge steps', () => {
    expect(stepForLiteral('1.0')).toBeCloseTo(0.1);
    expect(stepForLiteral('0.25')).toBeCloseTo(0.01);
    expect(stepForLiteral('2.')).toBeCloseTo(0.1);
    expect(stepForLiteral('3', true)).toBe(1);
  });
  it('decimals for a step', () => {
    expect(decimalsForStep(0.1)).toBe(1);
    expect(decimalsForStep(0.05)).toBe(2);
    expect(decimalsForStep(1)).toBe(0);
    expect(decimalsForStep(0.001)).toBe(3);
  });
  it('formats floats GLSL style', () => {
    expect(formatFloat(2, 3)).toBe('2.0');
    expect(formatFloat(0.5, 3)).toBe('0.5');
    expect(formatFloat(0.123456, 3)).toBe('0.123');
    expect(formatFloat(-0.00001, 3)).toBe('0.0');
    expect(formatFloat(1.23456, 6, 4)).toBe('1.2346');
    expect(formatFloat(1.26, 0)).toBe('1.3');
    expect(formatFloat(NaN, 2)).toBe('0.0');
  });
  it('never zeroes small values because of the decimals cap', () => {
    expect(formatFloat(1e-5, 6, 4)).toBe('1e-5');
    expect(formatFloat(2e-5, 6, 4)).toBe('2e-5');
    expect(formatFloat(0.00025, 5, 4)).toBe('2.5e-4');
    expect(formatFloat(0.00025, 5, 6)).toBe('0.00025');
    expect(formatFloat(0.0123, 6, 4)).toBe('0.0123');
    // within the cap the requested precision decides (slider noise near 0 stays 0.0)
    expect(formatFloat(-0.00001, 3)).toBe('0.0');
    // exponent-styled source literals keep that style for tiny values only
    expect(formatFloat(2e-5, 5, 4, { exponent: true })).toBe('2e-5');
    expect(formatFloat(1.5e-5, 6, 4, { exponent: true })).toBe('1.5e-5');
    expect(formatFloat(0.5, 2, 4, { exponent: true })).toBe('0.5');
    expect(Number(formatFloat(1e-5, 6, 4))).toBe(1e-5);
    expect(formatInt(-0.2)).toBe('0');
    expect(formatInt(2.6)).toBe('3');
    expect(formatDisplay(-0.0001, 2)).toBe('0.00');
    expect(formatDisplay(1e-5, 4)).toBe('1e-5');
    expect(formatDisplay(-1.5e-5, 4)).toBe('-1.5e-5');
    expect(formatDisplay(0, 4)).toBe('0.0000');
  });
  it('picks smart ranges', () => {
    expect(smartRange(0.3)).toEqual({ min: 0, max: 1 });
    expect(smartRange(-0.3)).toEqual({ min: -1, max: 1 });
    expect(smartRange(2.5)).toEqual({ min: 0, max: 5 });
    expect(smartRange(10)).toEqual({ min: 0, max: 20 });
    expect(smartRange(-40)).toEqual({ min: -100, max: 100 });
    // headroom: common values never sit at the end of the track, small ones are not squeezed
    expect(smartRange(1)).toEqual({ min: 0, max: 2 });
    expect(smartRange(0.035)).toEqual({ min: 0, max: 0.1 });
    expect(smartRange(0.5)).toEqual({ min: 0, max: 1 });
    expect(smartRange(3)).toEqual({ min: 0, max: 10 });
    expect(smartRange(0)).toEqual({ min: 0, max: 1 });
    expect(smartRange(0.7)).toEqual({ min: 0, max: 2 });
    expect(stepForRange(0, 1)).toBeCloseTo(0.001);
    expect(stepForRange(0, 10)).toBeCloseTo(0.01);
    expect(snap(0.1 + 0.2, 0.1)).toBe(0.3);
  });
  it('fingerprints lines', () => {
    expect(lineFingerprint('  vec3 col  = vec3(1.0, .5, 2);')).toBe('vec3 col = vec3(#, #, #);');
    expect(lineFingerprint('float x1 = 3.0e-2;')).toBe('float x1 = #;');
  });
});
