import { describe, expect, it } from 'vitest';
import { parseNumber, typedDecimals } from '../webview/src/math/range';
import { formatFloat } from '../shared/valuesMath';
import { buildReplacement } from '../client/src/values/editText';

// Inline row edit (List.ts) and widget inputs: what gets written for a typed value.
const written = (typed: string, maxDecimals = 4) => {
  const v = parseNumber(typed)!;
  return formatFloat(v, typedDecimals(v, typed), maxDecimals);
};

describe('typedDecimals (inline edit / typed values)', () => {
  it('is exponent aware', () => {
    expect(typedDecimals(1e-5, '1e-5')).toBe(5);
    expect(typedDecimals(1.5e-5, '1.5e-5')).toBe(6);
    expect(typedDecimals(1.5e-7)).toBe(8);
    expect(typedDecimals(2, '2')).toBe(1);
    expect(typedDecimals(0.5, '0.50')).toBe(2);
    expect(typedDecimals(1.25)).toBe(2);
  });

  it('never writes tiny typed values as 0.0', () => {
    expect(written('1e-5')).toBe('1e-5');
    expect(written('1.5e-5')).toBe('1.5e-5');
    expect(written('1.5E-7')).toBe('1.5e-7');
    expect(written('0.00002')).toBe('2e-5');
    expect(written('0.25')).toBe('0.25');
    expect(written('3')).toBe('3.0');
    expect(written('1.5e-5', 6)).toBe('0.000015');
  });

  it('survives the replacement builder (inline edit of `eps = 0.5;`)', () => {
    const src = 'eps = 0.5;';
    const g = { slots: [{ start: 6, end: 9, text: '0.5', value: 0.5, editable: true, integer: false }] };
    for (const [typed, out] of [['1e-5', 'eps = 1e-5;'], ['1.5e-5', 'eps = 1.5e-5;']] as const) {
      const v = parseNumber(typed)!;
      expect(buildReplacement(src, 0, [g], [v], typedDecimals(v, typed), 4)).toBe(out);
    }
  });
});
