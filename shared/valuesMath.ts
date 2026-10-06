// Pure number helpers shared by the client (writing literals, nudge) and the
// webview (display, slider steps, smart ranges). No imports; DOM/node free.
// Rules are specified in docs/VALUES.md "Number formatting".

/** Hard limits for decimals written to the document. */
export const MIN_DECIMALS = 1;
export const MAX_DECIMALS = 6;

/** Number of digits after '.' in a literal's text (`1.250` -> 3, `2.` -> 0, `3` -> 0, `1e-3` -> 3). */
export function literalDecimals(text: string): number {
  const t = text.trim().replace(/[fF]$/, '');
  const exp = /[eE]([+-]?\d+)$/.exec(t);
  const mantissa = exp ? t.slice(0, exp.index) : t;
  const dot = mantissa.indexOf('.');
  const frac = dot < 0 ? 0 : mantissa.length - dot - 1;
  const e = exp ? Number(exp[1]) : 0;
  return Math.max(0, frac - e);
}

/** Decimals needed to represent `step` (0.1 -> 1, 0.05 -> 2, 1 -> 0, 0.001 -> 3). */
export function decimalsForStep(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 2;
  for (let d = 0; d <= MAX_DECIMALS; d++) {
    const scaled = step * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)) return d;
  }
  return MAX_DECIMALS;
}

/**
 * Nudge step for a literal: one unit of its last decimal place, but at least
 * 0.1-precision granularity for floats written without fraction digits
 * (`1.0` -> 0.1, `0.25` -> 0.01, `2.` -> 0.1, integer `3` -> 1).
 */
export function stepForLiteral(text: string, integer = false): number {
  if (integer) return 1;
  const d = Math.max(1, Math.min(MAX_DECIMALS, literalDecimals(text)));
  return 10 ** -d;
}

/**
 * Formats a float literal for GLSL:
 *  - rounded to `decimals` (clamped to [1, maxDecimals]),
 *  - trailing zeros trimmed but always keeps a '.' and one digit (`2.0`, `0.5`),
 *  - no `-0.0`; non-finite -> `0.0`.
 *  - Small values are never zeroed by the cap: when the requested `decimals`
 *    exceed `maxDecimals` and |value| < 10^(1 - maxDecimals), the value is
 *    written with an exponent instead (`1e-5`, `2.5e-4`).
 *  - `opts.exponent` (the source literal used one): values with |v| < 1e-3 or
 *    >= 1e6 keep the exponent form.
 */
export function formatFloat(value: number, decimals: number, maxDecimals = 4, opts: { exponent?: boolean } = {}): string {
  if (!Number.isFinite(value)) return '0.0';
  const hi = clamp(Math.round(maxDecimals), MIN_DECIMALS, MAX_DECIMALS);
  const want = Math.round(Number.isFinite(decimals) ? decimals : 2);
  const d = clamp(want, MIN_DECIMALS, hi);
  const abs = Math.abs(value);
  if (abs > 0) {
    const tiny = want > hi && abs < 10 ** (1 - hi);
    const expStyle = !!opts.exponent && (abs < 1e-3 || abs >= 1e6);
    if (tiny || expStyle) return formatExponent(value, Math.max(want, d));
  }
  let s = value.toFixed(d);
  if (s.includes('.')) s = s.replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  if (/^-0\.0$/.test(s)) s = '0.0';
  return s;
}

/** `2.5e-5`-style float literal keeping the precision of `decimals` absolute decimals (at least one significant digit). */
export function formatExponent(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value === 0) return '0.0';
  const e = Math.floor(Math.log10(Math.abs(value)));
  const md = clamp(Math.round(decimals) + e, 0, MAX_DECIMALS);
  const [mant, exp] = value.toExponential(md).split('e');
  let m = mant;
  if (m.includes('.')) m = m.replace(/0+$/, '').replace(/\.$/, '');
  const x = Number(exp);
  return x === 0 ? (m.includes('.') ? m : m + '.0') : `${m}e${x}`;
}

/** Formats an integer literal (`3`, `-2`). */
export function formatInt(value: number): string {
  const v = Math.round(Number.isFinite(value) ? value : 0);
  return String(Object.is(v, -0) ? 0 : v);
}

/** Display formatting for the UI (not for the document): fixed decimals, no trimming, '−' kept as '-'. */
export function formatDisplay(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '—';
  const d = Math.max(0, Math.min(MAX_DECIMALS, Math.round(decimals)));
  const s = value.toFixed(d);
  if (/^-?0(\.0*)?$/.test(s)) {
    // A nonzero value below the panel's 4-decimal display cap (1e-5) would
    // read as 0, as if the edit had failed.
    if (value !== 0 && Math.abs(value) < 0.5e-4) return value.toExponential(1).replace(/\.0e/, 'e').replace('e+', 'e');
    return s.replace(/^-/, '');
  }
  return s;
}

/**
 * A "nice" default slider range around a value without explicit bounds. The
 * value should sit well inside the track with room to grow:
 *   |v| in [0.1, 0.5]  -> [0, 1]  (negative: [-1, 1])
 *   otherwise          -> [0, m]  with m the smallest 1/2/5 x 10^n >= 2|v|
 *                         (1.0 -> 2, 0.035 -> 0.1, 3 -> 10); negative: [-m, m]
 *   0                  -> [0, 1]
 */
export function smartRange(value: number): { min: number; max: number } {
  if (!Number.isFinite(value) || value === 0) return { min: 0, max: 1 };
  const a = Math.abs(value);
  const m = a >= 0.1 && a <= 0.5 ? 1 : niceCeil(2 * a);
  return value > 0 ? { min: 0, max: m } : { min: -m, max: m };
}

/** Smallest 1, 2 or 5 x 10^n that is >= x (x > 0). */
export function niceCeil(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const k of [1, 2, 5, 10]) {
    const v = Number((k * p).toPrecision(12));
    if (v >= x * (1 - 1e-12)) return v;
  }
  return 10 * p;
}

/** A slider step for a range: ~1/1000 of the span rounded down to a power of ten (range 0..1 -> 0.001). */
export function stepForRange(min: number, max: number): number {
  const span = Math.abs(max - min);
  if (!(span > 0)) return 0.01;
  return 10 ** Math.floor(Math.log10(span / 1000) + 1e-9);
}

/** Rounds `v` to a multiple of `step` (avoids 0.30000000000000004). */
export function snap(v: number, step: number): number {
  if (!(step > 0)) return v;
  const d = decimalsForStep(step);
  return Number((Math.round(v / step) * step).toFixed(d));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Line fingerprint used by pin anchors: numbers -> '#', whitespace collapsed, trimmed. */
export function lineFingerprint(line: string): string {
  return line
    .replace(/(?<![\w.])(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFuU]?(?![\w.])/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}
