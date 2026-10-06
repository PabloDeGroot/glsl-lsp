// Pure helpers for iq's cosine palettes: col(t) = a + b * cos(2*pi*(c*t + d)).

import type { RGB } from './color';

export interface Palette {
  a: RGB;
  b: RGB;
  c: RGB;
  d: RGB;
}

export const PALETTE_KEYS = ['a', 'b', 'c', 'd'] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];

export const PALETTE_ROLES: Record<PaletteKey, string> = {
  a: 'offset',
  b: 'amplitude',
  c: 'frequency',
  d: 'phase',
};

/** Default slider ranges per row (extended when a value lies outside). */
export const PALETTE_RANGES: Record<PaletteKey, { min: number; max: number }> = {
  a: { min: 0, max: 1 },
  b: { min: 0, max: 1 },
  c: { min: 0, max: 2 },
  d: { min: 0, max: 1 },
};

/** Unclamped palette color at t. */
export function evalPalette(p: Palette, t: number): RGB {
  const ch = (i: 0 | 1 | 2) => p.a[i] + p.b[i] * Math.cos(2 * Math.PI * (p.c[i] * t + p.d[i]));
  return [ch(0), ch(1), ch(2)];
}

/** Samples n + 1 evenly spaced colors over t in [0, 1]. */
export function samplePalette(p: Palette, n: number): RGB[] {
  const out: RGB[] = [];
  for (let i = 0; i <= n; i++) out.push(evalPalette(p, i / n));
  return out;
}

/** 12 numbers a.rgb, b.rgb, c.rgb, d.rgb (the EditUpdate layout for a palette without childIndex). */
export function flattenPalette(p: Palette): number[] {
  return [...p.a, ...p.b, ...p.c, ...p.d];
}

export function paletteFromFlat(v: readonly number[]): Palette {
  const g = (i: number): RGB => [v[i] ?? 0, v[i + 1] ?? 0, v[i + 2] ?? 0];
  return { a: g(0), b: g(3), c: g(6), d: g(9) };
}

export interface PalettePreset {
  name: string;
  palette: Palette;
}

/** iq's classic set (https://iquilezles.org/articles/palettes/). */
export const PALETTE_PRESETS: PalettePreset[] = [
  { name: 'Rainbow', palette: { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0, 0.33, 0.67] } },
  { name: 'Ember', palette: { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0, 0.1, 0.2] } },
  { name: 'Dusk', palette: { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0.3, 0.2, 0.2] } },
  { name: 'Lagoon', palette: { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 0.5], d: [0.8, 0.9, 0.3] } },
  { name: 'Candy', palette: { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 0.7, 0.4], d: [0, 0.15, 0.2] } },
  { name: 'Toxic', palette: { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [2, 1, 0], d: [0.5, 0.2, 0.25] } },
  { name: 'Desert', palette: { a: [0.8, 0.5, 0.4], b: [0.2, 0.4, 0.2], c: [2, 1, 1], d: [0, 0.25, 0.25] } },
];
