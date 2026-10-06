// Row glyphs (16x16, drawn with DOM/SVG) and value-preview models for list
// rows and the widget header.

import type { RowOptions, RowState, ValueTarget } from '../../../shared/valuesProtocol';
import { formatDisplay } from '../../../shared/valuesMath';
import { iconEl } from '../icons';
import { cssRgb, splitHdr, type RGB } from '../math/color';
import { evalPalette, type Palette } from '../math/palette';
import { floatRange, previewDecimals, shownDecimals, toFraction, vec2Range } from '../math/range';
import { chooseWidget, expandedValues } from '../math/targets';

const SVGNS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export function paletteOf(target: ValueTarget): Palette | null {
  const ch = target.children;
  if (!ch || ch.length !== 4) return null;
  const v = ch.map((c) => {
    const e = expandedValues(c);
    return [e[0] ?? 0, e[1] ?? 0, e[2] ?? 0].map((x) => (Number.isFinite(x) ? x : 0)) as RGB;
  });
  return { a: v[0], b: v[1], c: v[2], d: v[3] };
}

/** CSS linear-gradient of a palette over t in [0, 1]. */
export function paletteGradient(p: Palette, stops = 16): string {
  const parts: string[] = [];
  for (let i = 0; i <= stops; i++) parts.push(`${cssRgb(evalPalette(p, i / stops))} ${((i / stops) * 100).toFixed(1)}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

type GlyphSpec =
  | { kind: 'gauge'; f: number; neg: boolean }
  | { kind: 'dot'; x: number; y: number }
  | { kind: 'swatch'; color: string; alpha: boolean }
  | { kind: 'arrow'; angle: number; flat: boolean }
  | { kind: 'strip'; gradient: string }
  | { kind: 'icon'; icon: 'hash' | 'warning' | 'target' | 'vector' | 'file'; tone?: 'muted' | 'warn' };

export function glyphSpec(row: RowState | undefined, target: ValueTarget | undefined, options: RowOptions | undefined): GlyphSpec {
  if (row && row.status === 'stale') return { kind: 'icon', icon: 'warning', tone: 'warn' };
  if (!target) return { kind: 'icon', icon: row?.status === 'noEditor' ? 'file' : 'target', tone: 'muted' };
  const vals = expandedValues(target);
  switch (chooseWidget(target, options)) {
    case 'slider': {
      const v = vals[0];
      const r = floatRange(v, target.uniform, options);
      return { kind: 'gauge', f: toFraction(v, r), neg: v < 0 };
    }
    case 'trackpad': {
      const r = vec2Range(vals[0], vals[1], target.uniform, options);
      return { kind: 'dot', x: toFraction(vals[0], r), y: toFraction(vals[1], r) };
    }
    case 'color': {
      // HDR colors preview their chroma (the intensity is shown in the picker).
      const rgb: RGB = splitHdr([vals[0], vals[1], vals[2]]).chroma;
      const a = target.kind === 'vec4' ? vals[3] : 1;
      return { kind: 'swatch', color: cssRgb(rgb, a), alpha: target.kind === 'vec4' && a < 1 };
    }
    case 'vector': {
      const x = vals[0];
      const y = vals[1];
      const flat = Math.hypot(x, y) < 1e-6;
      return { kind: 'arrow', angle: flat ? 0 : (Math.atan2(-y, x) * 180) / Math.PI, flat };
    }
    case 'palette': {
      const p = paletteOf(target);
      return p ? { kind: 'strip', gradient: paletteGradient(p, 8) } : { kind: 'icon', icon: 'hash' };
    }
    case 'stack':
      return target.colorish && vals.slice(0, 3).every(Number.isFinite)
        ? { kind: 'swatch', color: cssRgb([vals[0], vals[1], vals[2]]), alpha: false }
        : { kind: 'icon', icon: 'vector' };
    default:
      return { kind: 'icon', icon: 'hash' };
  }
}

/** Renders (or patches) a glyph into `host` (a 16x16 span). */
export function renderGlyph(host: HTMLElement, spec: GlyphSpec): void {
  const sig = spec.kind === 'icon' ? `icon:${spec.icon}:${spec.tone ?? ''}` : spec.kind;
  if (host.dataset.sig !== sig) {
    host.dataset.sig = sig;
    host.replaceChildren();
    host.className = `glyph glyph-${spec.kind}`;
    switch (spec.kind) {
      case 'gauge': {
        const s = svgEl('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
        s.append(
          svgEl('circle', { class: 'gauge-track', cx: 8, cy: 8, r: 5.5, fill: 'none', 'stroke-width': 2 }),
          svgEl('circle', {
            class: 'gauge-value',
            cx: 8,
            cy: 8,
            r: 5.5,
            fill: 'none',
            'stroke-width': 2,
            pathLength: 100,
            transform: 'rotate(-90 8 8)',
            'stroke-linecap': 'round',
          }),
        );
        host.append(s);
        break;
      }
      case 'dot': {
        const s = svgEl('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
        s.append(
          svgEl('rect', { class: 'dot-frame', x: 2.5, y: 2.5, width: 11, height: 11, rx: 1.5, fill: 'none' }),
          svgEl('circle', { class: 'dot-point', cx: 8, cy: 8, r: 2 }),
        );
        host.append(s);
        break;
      }
      case 'swatch':
        host.append(document.createElement('span'));
        host.firstElementChild!.className = 'swatch-fill';
        break;
      case 'arrow': {
        const s = svgEl('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
        const g = svgEl('g', { class: 'arrow-g', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
        g.append(svgEl('path', { d: 'M3 8h9.5M9.5 5l3 3-3 3' }));
        s.append(g, svgEl('circle', { class: 'arrow-flat', cx: 8, cy: 8, r: 2.2, fill: 'currentColor' }));
        host.append(s);
        break;
      }
      case 'strip':
        host.append(document.createElement('span'));
        host.firstElementChild!.className = 'strip-fill';
        break;
      case 'icon':
        host.append(iconEl(spec.icon));
        if (spec.tone) host.classList.add(`tone-${spec.tone}`);
        break;
    }
  }
  switch (spec.kind) {
    case 'gauge': {
      const c = host.querySelector('.gauge-value')!;
      const pct = Math.max(0.001, spec.f * 100);
      c.setAttribute('stroke-dasharray', `${pct.toFixed(2)} 100`);
      break;
    }
    case 'dot': {
      const c = host.querySelector('.dot-point')!;
      c.setAttribute('cx', (3.5 + spec.x * 9).toFixed(2));
      c.setAttribute('cy', (12.5 - spec.y * 9).toFixed(2));
      break;
    }
    case 'swatch': {
      const f = host.firstElementChild as HTMLElement;
      f.style.background = spec.color;
      host.classList.toggle('has-alpha', spec.alpha);
      break;
    }
    case 'arrow': {
      host.querySelector('.arrow-g')!.setAttribute('transform', `rotate(${spec.angle.toFixed(1)} 8 8)`);
      host.classList.toggle('flat', spec.flat);
      break;
    }
    case 'strip':
      (host.firstElementChild as HTMLElement).style.background = spec.gradient;
      break;
  }
}

export interface PreviewNum {
  text: string;
  /** Component index (scrub target); undefined for locked components. */
  comp?: number;
  locked?: boolean;
}

export type PreviewSpec =
  | { kind: 'nums'; nums: PreviewNum[] }
  | { kind: 'text'; text: string; tone?: 'muted' | 'warn' }
  | { kind: 'strip'; gradient: string }
  | { kind: 'loading' }
  | { kind: 'none' };

export function previewSpec(row: RowState | undefined, target: ValueTarget | undefined): PreviewSpec {
  if (row?.status === 'loading') return { kind: 'loading' };
  if (row?.status === 'stale') return { kind: 'text', text: 'not found', tone: 'warn' };
  if (!target) return { kind: 'none' };
  if (target.kind === 'multi') return { kind: 'text', text: `${target.children?.length ?? 0} values`, tone: 'muted' };
  if (target.kind === 'palette') {
    const p = paletteOf(target);
    return p ? { kind: 'strip', gradient: paletteGradient(p) } : { kind: 'none' };
  }
  const vector = target.kind !== 'float';
  const vals = expandedValues(target);
  const nums: PreviewNum[] = vals.map((v, i) => {
    const c = target.components[target.splat ? 0 : i];
    if (!c || !c.editable) return { text: c?.text ?? '?', locked: true };
    return { text: formatDisplay(v, shownDecimals(v, previewDecimals(c.text, c.integer, vector))), comp: i };
  });
  return { kind: 'nums', nums };
}
