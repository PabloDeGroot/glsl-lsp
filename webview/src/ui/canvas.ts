// DPR-crisp canvases redrawn on demand (rAF, only when dirty), plus theme
// colors read from the --vscode-* variables and refreshed on theme change.

import { withAlpha } from '../math/color';

export interface Theme {
  fg: string;
  muted: string;
  bg: string;
  canvasBg: string;
  grid: string;
  border: string;
  focus: string;
  accent: string;
  accentFg: string;
  axis: [string, string, string, string];
  dark: boolean;
  highContrast: boolean;
  mono: string;
  font: string;
}

let cached: Theme | null = null;
const themeListeners = new Set<() => void>();

function readVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = style.getPropertyValue(name).trim();
  return v || fallback;
}

export function theme(): Theme {
  if (cached) return cached;
  // body: theme-class overrides of the --gv-* roles apply there (custom properties resolve var()).
  const style = getComputedStyle(document.body);
  const cls = document.body.classList;
  const dark = cls.contains('vscode-dark') || cls.contains('vscode-high-contrast');
  const fg = readVar(style, '--vscode-foreground', dark ? '#cccccc' : '#3b3b3b');
  cached = {
    fg,
    muted: readVar(style, '--vscode-descriptionForeground', withAlpha(fg, 0.7)),
    bg: readVar(style, '--vscode-sideBar-background', dark ? '#181818' : '#f8f8f8'),
    canvasBg: readVar(style, '--vscode-editor-background', dark ? '#1f1f1f' : '#ffffff'),
    grid: withAlpha(fg, dark ? 0.09 : 0.1),
    border: readVar(style, '--vscode-widget-border', withAlpha(fg, 0.2)),
    focus: readVar(style, '--vscode-focusBorder', '#0078d4'),
    accent: readVar(style, '--gv-button', readVar(style, '--vscode-button-background', '#0078d4')),
    accentFg: readVar(style, '--vscode-button-foreground', '#ffffff'),
    axis: [
      readVar(style, '--vscode-charts-red', '#f14c4c'),
      readVar(style, '--vscode-charts-green', '#89d185'),
      readVar(style, '--vscode-charts-blue', '#3794ff'),
      readVar(style, '--vscode-charts-yellow', '#cca700'),
    ],
    dark,
    highContrast: cls.contains('vscode-high-contrast') || cls.contains('vscode-high-contrast-light'),
    mono: readVar(style, '--vscode-editor-font-family', 'monospace').split(',')[0].trim() || 'monospace',
    font: readVar(style, '--vscode-font-family', 'sans-serif'),
  };
  return cached;
}

export function onThemeChange(cb: () => void): () => void {
  themeListeners.add(cb);
  return () => themeListeners.delete(cb);
}

function themeChanged(): void {
  cached = null;
  for (const cb of themeListeners) cb();
}

let watching = false;
function watchTheme(): void {
  if (watching) return;
  watching = true;
  const mo = new MutationObserver(themeChanged);
  mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
}

let dprListeners = new Set<() => void>();
function watchDpr(): void {
  const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener(
    'change',
    () => {
      for (const cb of dprListeners) cb();
      watchDpr();
    },
    { once: true },
  );
}
let dprWatching = false;

export type DrawFn = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

/**
 * A canvas whose CSS size is controlled by stylesheet classes; its backing
 * store follows the element size x devicePixelRatio. `invalidate()` schedules
 * one redraw on the next animation frame.
 */
export class CanvasView {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  private frame = 0;
  private ro: ResizeObserver;
  private offTheme: () => void;
  private onDpr = () => this.resize();

  constructor(
    className: string,
    private readonly draw: DrawFn,
  ) {
    watchTheme();
    if (!dprWatching) {
      dprWatching = true;
      watchDpr();
    }
    this.canvas = document.createElement('canvas');
    this.canvas.className = className;
    this.ctx = this.canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
    this.offTheme = onThemeChange(() => this.invalidate());
    dprListeners.add(this.onDpr);
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.w = w;
    this.h = h;
    this.paint();
  }

  invalidate(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint(): void {
    if (this.w <= 0 || this.h <= 0) return;
    const dpr = this.canvas.width / this.w;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.w, this.h);
    this.draw(this.ctx, this.w, this.h);
  }

  /** Pointer position in CSS pixels relative to the canvas. */
  local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.ro.disconnect();
    this.offTheme();
    dprListeners.delete(this.onDpr);
  }
}

/** Crisp 1px line coordinate. */
export const px = (x: number): number => Math.round(x) + 0.5;

/** Checkerboard fill for alpha previews. */
export function checker(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, size = 4): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#cccccc';
  for (let j = 0; j * size < h; j++) for (let i = (j % 2); i * size < w; i += 2) ctx.fillRect(x + i * size, y + j * size, size, size);
  ctx.restore();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
