// Pure color helpers for the Values webview (no DOM): rgb <-> hsv <-> hex,
// HDR chroma/intensity split, and CSS color parsing for theme-driven canvases.
// RGB components are floats in [0, 1] unless stated otherwise.

export type RGB = [number, number, number];

export interface HSV {
  /** Hue in degrees [0, 360). */
  h: number;
  /** Saturation [0, 1]. */
  s: number;
  /** Value [0, 1]. */
  v: number;
}

export const clamp01 = (x: number): number => (!Number.isFinite(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x);

export function hsvToRgb(h: number, s: number, v: number): RGB {
  const hh = (((h % 360) + 360) % 360) / 60;
  const ss = clamp01(s);
  const vv = clamp01(v);
  const c = vv * ss;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = vv - c;
  let rgb: RGB;
  if (hh < 1) rgb = [c, x, 0];
  else if (hh < 2) rgb = [x, c, 0];
  else if (hh < 3) rgb = [0, c, x];
  else if (hh < 4) rgb = [0, x, c];
  else if (hh < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

/**
 * RGB -> HSV. For greys (s = 0) and black (v = 0) hue/saturation are
 * undefined: `prev` keeps them stable so dragging V to 0 does not lose the hue.
 */
export function rgbToHsv(rgb: RGB, prev?: HSV): HSV {
  const r = clamp01(rgb[0]);
  const g = clamp01(rgb[1]);
  const b = clamp01(rgb[2]);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let s = max === 0 ? 0 : d / max;
  let h: number;
  if (d === 0) h = prev?.h ?? 0;
  else if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  if (max === 0 && prev) s = prev.s;
  return { h, s, v: max };
}

const hex2 = (x: number): string =>
  Math.round(clamp01(x) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();

/** `#RRGGBB`, or `#RRGGBBAA` when `alpha` is given. Components are clamped to [0, 1]. */
export function rgbToHex(rgb: RGB, alpha?: number): string {
  return '#' + rgb.map(hex2).join('') + (alpha === undefined ? '' : hex2(alpha));
}

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (the `#` is optional). */
export function parseHex(input: string): { rgb: RGB; alpha?: number } | null {
  const s = input.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  let full: string;
  if (s.length === 3 || s.length === 4) full = [...s].map((c) => c + c).join('');
  else if (s.length === 6 || s.length === 8) full = s;
  else return null;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  const rgb: RGB = [n(0), n(2), n(4)];
  return full.length === 8 ? { rgb, alpha: n(6) } : { rgb };
}

/**
 * HDR split: colors with a component > 1 are edited as `chroma * k` where
 * k = max component and chroma is in [0, 1]. LDR colors have k = 1.
 */
export function splitHdr(rgb: RGB): { chroma: RGB; k: number } {
  const k = Math.max(rgb[0], rgb[1], rgb[2]);
  if (!(k > 1)) return { chroma: [rgb[0], rgb[1], rgb[2]], k: 1 };
  return { chroma: [rgb[0] / k, rgb[1] / k, rgb[2] / k], k };
}

/** CSS `rgb()`/`rgba()` string from 0..1 components (clamped). */
export function cssRgb(rgb: RGB, alpha = 1): string {
  const c = rgb.map((x) => Math.round(clamp01(x) * 255));
  return alpha >= 1 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${+clamp01(alpha).toFixed(3)})`;
}

export interface RGBA255 {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

/** Parses the color forms VS Code puts into `--vscode-*` variables: hex (3/4/6/8) and rgb()/rgba(). */
export function parseCssColor(input: string): RGBA255 | null {
  const s = input.trim();
  if (s.startsWith('#')) {
    const p = parseHex(s);
    if (!p) return null;
    return { r: Math.round(p.rgb[0] * 255), g: Math.round(p.rgb[1] * 255), b: Math.round(p.rgb[2] * 255), a: p.alpha ?? 1 };
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (!m) return null;
  let a = 1;
  if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: +m[1], g: +m[2], b: +m[3], a };
}

/** The same CSS color with its alpha multiplied by `alpha` (unparseable colors are returned unchanged). */
export function withAlpha(css: string, alpha: number): string {
  const c = parseCssColor(css);
  if (!c) return css;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${+(c.a * clamp01(alpha)).toFixed(3)})`;
}

/** Relative luminance (sRGB, 0..1): picks a readable marker/label color. */
export function luminance(rgb: RGB): number {
  const lin = (x: number) => {
    const c = clamp01(x);
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}
