// Pure range/step logic for sliders, trackpads and scrubbing.

import type { RowOptions, UniformInfo } from '../../../shared/valuesProtocol';
import { MAX_DECIMALS, decimalsForStep, literalDecimals, smartRange, stepForLiteral, stepForRange } from '../../../shared/valuesMath';

export interface NumRange {
  min: number;
  max: number;
}

export type RangeSource = 'uniform' | 'user' | 'auto';

export interface ResolvedRange extends NumRange {
  source: RangeSource;
}

const valid = (r: Partial<NumRange> | undefined): r is NumRange =>
  !!r && Number.isFinite(r.min) && Number.isFinite(r.max) && (r.max as number) > (r.min as number);

/** Slider range for one float: #iUniform bounds, else the user's range, else smartRange(value). */
export function floatRange(value: number, uniform?: UniformInfo, options?: RowOptions): ResolvedRange {
  if (uniform && valid({ min: uniform.min, max: uniform.max })) return { min: uniform.min!, max: uniform.max!, source: 'uniform' };
  if (valid(options?.range)) return { ...options!.range!, source: 'user' };
  return { ...smartRange(value), source: 'auto' };
}

/**
 * Square trackpad range for a vec2: uniform bounds, user range, else
 * smartRange of the largest magnitude (symmetric when any component is
 * negative), so 1.0 is not pinned to the edge.
 */
export function vec2Range(x: number, y: number, uniform?: UniformInfo, options?: RowOptions): ResolvedRange {
  if (uniform && valid({ min: uniform.min, max: uniform.max })) return { min: uniform.min!, max: uniform.max!, source: 'uniform' };
  if (valid(options?.range)) return { ...options!.range!, source: 'user' };
  const fx = Number.isFinite(x) ? x : 0;
  const fy = Number.isFinite(y) ? y : 0;
  const r = smartRange(Math.max(Math.abs(fx), Math.abs(fy)));
  return fx < 0 || fy < 0 ? { min: -r.max, max: r.max, source: 'auto' } : { min: 0, max: r.max, source: 'auto' };
}

/** Grows `r` so that it contains `v` (used when a typed value falls outside the slider). */
export function extendRange(r: NumRange, v: number): NumRange {
  if (!Number.isFinite(v) || (v >= r.min && v <= r.max)) return r;
  const s = smartRange(v);
  return { min: Math.min(r.min, s.min), max: Math.max(r.max, s.max) };
}

/** Ctrl+wheel zoom: scales the range around 0 (or around its center when 0 is outside). */
export function zoomRange(r: NumRange, factor: number): NumRange {
  const c = r.min <= 0 && r.max >= 0 ? 0 : (r.min + r.max) / 2;
  const min = c + (r.min - c) * factor;
  const max = c + (r.max - c) * factor;
  return max - min > 1e-6 ? { min: tidy(min), max: tidy(max) } : r;
}

const tidy = (x: number): number => Number(x.toPrecision(10));

export interface Steps {
  /** Smallest increment while dragging. */
  drag: number;
  /** Arrow key increment. */
  key: number;
  /** Decimals to write. */
  decimals: number;
}

/** Steps for a slider over `r` (uniform `step` wins; integers step 1). */
export function stepsFor(r: NumRange, opts: { uniformStep?: number; integer?: boolean } = {}): Steps {
  if (opts.integer) return { drag: 1, key: 1, decimals: 0 };
  const drag = opts.uniformStep && opts.uniformStep > 0 ? opts.uniformStep : stepForRange(r.min, r.max);
  const key = opts.uniformStep && opts.uniformStep > 0 ? opts.uniformStep : drag * 10;
  return { drag, key, decimals: Math.max(1, decimalsForStep(drag)) };
}

/** Value -> [0,1] position within the range (clamped). */
export function toFraction(v: number, r: NumRange): number {
  const span = r.max - r.min;
  if (!(span > 0) || !Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, (v - r.min) / span));
}

export function fromFraction(f: number, r: NumRange): number {
  return r.min + Math.min(1, Math.max(0, f)) * (r.max - r.min);
}

/** `count` evenly spaced tick values including both ends. */
export function ticks(r: NumRange, count = 5): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(tidy(r.min + ((r.max - r.min) * i) / (count - 1)));
  return out;
}

/** Keyboard modifier multiplier: Shift x10, Alt x0.1. */
export function modifierFactor(e: { shiftKey: boolean; altKey: boolean }): number {
  return e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
}

/** Scrub step per pixel for a literal (list scrubbing, label scrubbing). */
export function scrubStep(text: string, integer: boolean | undefined, e: { shiftKey: boolean; altKey: boolean }): number {
  const base = stepForLiteral(text, !!integer);
  const f = modifierFactor(e);
  return integer ? Math.max(1, Math.round(base * f)) : base * f;
}

/** Decimals to write while scrubbing a literal: its own decimals, at least those of the step. */
export function scrubDecimals(text: string, step: number, integer?: boolean): number {
  if (integer) return 0;
  const own = Math.max(1, decimalsForStep(stepForLiteral(text)));
  return Math.min(MAX_DECIMALS, Math.max(own, decimalsForStep(step)));
}

/**
 * Display decimals of a component, the same in the list and in every widget
 * input: the literal's own precision (`1.25` -> 2, `0.200` -> 3, `1.0` -> 1),
 * 1..4; integers 0. Never depends on the panel width.
 */
export function displayDecimals(text: string | undefined, integer?: boolean): number {
  if (integer) return 0;
  if (text === undefined) return 2;
  const body = text.trim().replace(/(?:lf|LF|[fF])$/, '');
  return Math.min(4, Math.max(1, literalDecimals(body)));
}

/** Fewest decimals (<= max) that show `v` exactly (0.51 -> 2, 2 -> 0). */
export function minimalDecimals(v: number, max = 4): number {
  if (!Number.isFinite(v)) return 0;
  for (let d = 0; d < max; d++) if (Math.abs(Number(v.toFixed(d)) - v) < 1e-9 * Math.max(1, Math.abs(v))) return d;
  return max;
}

/** Decimals to show `v` for a literal with `own` display decimals: its own, more only when the value needs them. */
export function shownDecimals(v: number, own: number): number {
  return Math.max(own, minimalDecimals(v, 4));
}

/** List preview decimals: same rule as the widget inputs (`displayDecimals`). */
export function previewDecimals(text: string, integer: boolean | undefined, _vector?: boolean): number {
  return displayDecimals(text, integer);
}

/** Parses a typed number (accepts `1.`, `.5`, `-0.25`, `1e-3`, trailing `f`, a comma decimal). */
export function parseNumber(input: string): number | null {
  const s = input.trim().replace(/[fF]$/, '').replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/**
 * Decimals to write for a typed value, exponent aware: `1.25` -> 2,
 * `1e-5` -> 5, `1.5e-5` -> 6, `2` -> 1 (at least 1). The typed `text` keeps
 * its trailing zeros (`0.50` -> 2); without it the value's shortest form is
 * used. Small values get more decimals than the write cap, which makes the
 * formatter switch to an exponent (`1e-5`) instead of writing `0.0`.
 */
export function typedDecimals(v: number, text?: string): number {
  if (!Number.isFinite(v)) return 1;
  const own = literalDecimals(String(v));
  const typed = text !== undefined ? literalDecimals(text.trim().replace(/[fF]$/, '').replace(',', '.')) : 0;
  return Math.max(1, own, typed);
}
