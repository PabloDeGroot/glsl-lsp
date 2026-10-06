// palette -> cosine palette editor: live gradient strip (hover shows t and
// color), r/g/b curves, a/b/c/d rows of scrubbable numbers, iq presets.

import { formatDisplay } from '../../../shared/valuesMath';
import { EditSession } from '../bridge';
import { iconEl } from '../icons';
import { cssRgb, rgbToHex, withAlpha, type RGB } from '../math/color';
import { evalPalette, flattenPalette, PALETTE_KEYS, PALETTE_PRESETS, PALETTE_ROLES, type Palette, type PaletteKey } from '../math/palette';
import { paletteGradient, paletteOf } from '../list/preview';
import { CanvasView, theme } from '../ui/canvas';
import { h, iconButton, setText, toggle } from '../ui/dom';
import { NumberInput, type Axis, type ChangePhase } from '../ui/NumberInput';
import { typedDecimals } from './FloatSlider';
import { displayDecimals } from '../math/range';
import type { Widget, WidgetContext } from './types';

const DECIMALS = 3;
const AXES: Axis[] = ['x', 'y', 'z'];

export class PaletteEditor implements Widget {
  readonly el: HTMLElement;
  private ctx: WidgetContext;
  private p: Palette;
  private strip: CanvasView;
  private curves: CanvasView;
  private tip: HTMLElement;
  private hoverT: number | null = null;
  private sessions: EditSession[];
  private inputs: NumberInput[][] = [];
  private swatches: HTMLElement[] = [];
  private menu: HTMLElement | null = null;
  private presetBtn: HTMLButtonElement;
  private offDoc: (() => void) | null = null;
  private rows: HTMLElement[] = [];
  private formula: HTMLElement;

  constructor(ctx: WidgetContext) {
    this.ctx = ctx;
    this.p = paletteOf(ctx.target) ?? PALETTE_PRESETS[0].palette;
    this.sessions = PALETTE_KEYS.map((_, i) => new EditSession(ctx.bridge, { rowId: ctx.ref.rowId, childIndex: i }));

    this.strip = new CanvasView('strip-canvas', (c, w, hh) => this.drawStrip(c, w, hh));
    this.curves = new CanvasView('curves-canvas', (c, w, hh) => this.drawCurves(c, w, hh));
    this.strip.canvas.setAttribute('role', 'img');
    this.strip.canvas.setAttribute('aria-label', 'Palette gradient');
    this.curves.canvas.setAttribute('role', 'img');
    this.curves.canvas.setAttribute('aria-label', 'Red, green and blue curves over t');
    this.tip = h('div.strip-tip', { 'aria-hidden': 'true' });
    this.strip.canvas.addEventListener('pointermove', (e) => {
      const x = this.strip.local(e).x;
      this.hoverT = Math.min(1, Math.max(0, x / this.strip.w));
      this.renderTip(x);
      this.strip.invalidate();
      this.curves.invalidate();
    });
    this.strip.canvas.addEventListener('pointerleave', () => {
      this.hoverT = null;
      toggle(this.tip, 'visible', false);
      this.strip.invalidate();
      this.curves.invalidate();
    });

    const head = h(
      'div.palette-head',
      null,
      h('span.palette-col-key'),
      h('span.palette-col-sw'),
      ...['r', 'g', 'b'].map((c, i) => h(`span.palette-col.axis-${AXES[i]}`, null, c)),
      h('span.palette-col-go'),
    );
    const rows = PALETTE_KEYS.map((key, ki) => this.row(key, ki));
    this.rows = rows;

    this.presetBtn = h('button.button.secondary.small', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, iconEl('preset'), h('span', null, 'Presets'));
    this.presetBtn.addEventListener('click', () => (this.menu ? this.closeMenu() : this.openMenu()));
    this.formula = h('span.palette-formula', { title: 'iq cosine palette' }, 'a + b·cos(2π(c·t + d))');
    const formula = this.formula;

    this.el = h(
      'div.w-palette',
      null,
      h('div.strip-wrap', null, this.strip.canvas, this.tip),
      this.curves.canvas,
      h('div.palette-grid', { role: 'group', 'aria-label': 'Palette coefficients' }, head, ...rows),
      h('div.palette-actions', null, formula, this.presetBtn),
    );
    this.update(ctx);
  }

  private row(key: PaletteKey, ki: number): HTMLElement {
    const sw = h('span.mini-swatch');
    this.swatches.push(sw);
    const inputs = AXES.map(
      (axis, ci) =>
        new NumberInput({
          axis,
          name: `${key}.${'rgb'[ci]}`,
          size: 'sm',
          scrubField: true,
          title: 'Drag to change · click to type',
          step: () => 0.01,
          decimals: () => DECIMALS,
          displayDecimals: () => {
            const child = this.ctx.target.children?.[ki];
            const c = child?.components[child.splat ? 0 : ci];
            return displayDecimals(c?.text, c?.integer);
          },
          change: (v, phase) => this.onChange(ki, ci, v, phase),
        }),
    );
    this.inputs.push(inputs);
    const go = iconButton('chevron', `Edit ${key} with its own widget`, { cls: 'palette-go' });
    go.addEventListener('click', () => this.ctx.select({ rowId: this.ctx.ref.rowId, childIndex: ki }));
    const label = h('span.palette-key', { title: PALETTE_ROLES[key] }, h('b', null, key), h('span.palette-role', null, PALETTE_ROLES[key]));
    return h('div.palette-row', null, label, sw, ...inputs.map((i) => i.el), go);
  }

  private onChange(ki: number, ci: number, v: number, phase: ChangePhase): void {
    const s = this.sessions[ki];
    const key = PALETTE_KEYS[ki];
    const vec = [...this.p[key]] as RGB;
    vec[ci] = v;
    if (phase === 'dragStart') {
      s.start();
      return;
    }
    this.p = { ...this.p, [key]: vec };
    if (phase === 'commit') s.once(vec, Math.max(DECIMALS, typedDecimals(v)));
    else if (phase === 'key') s.key(vec, DECIMALS);
    else if (phase === 'drag') s.move(vec, DECIMALS);
    else s.end(phase === 'dragEnd');
    this.render();
  }

  private openMenu(): void {
    const menu = h('div.menu', { role: 'menu', 'aria-label': 'Palette presets' });
    // Without a written c only presets with c = 1 can be applied faithfully.
    const cImplicit = !!this.ctx.target.children?.[2]?.implicit;
    PALETTE_PRESETS.filter((pr) => !cImplicit || pr.palette.c.every((x) => x === 1)).forEach((preset) => {
      const sw = h('span.menu-strip');
      sw.style.background = paletteGradient(preset.palette);
      const item = h('button.menu-item', { type: 'button', role: 'menuitem' }, sw, h('span', null, preset.name));
      item.addEventListener('click', () => {
        this.p = preset.palette;
        this.ctx.bridge.once({ rowId: this.ctx.ref.rowId }, flattenPalette(preset.palette), DECIMALS);
        this.closeMenu();
        this.render();
        this.presetBtn.focus();
      });
      menu.append(item);
    });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>('.menu-item')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
      else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
      else if (e.key === 'Escape') {
        this.closeMenu();
        this.presetBtn.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    this.presetBtn.parentElement!.append(menu);
    this.menu = menu;
    this.presetBtn.setAttribute('aria-expanded', 'true');
    (menu.firstElementChild as HTMLElement | null)?.focus();
    const onDoc = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node) && e.target !== this.presetBtn && !this.presetBtn.contains(e.target as Node)) this.closeMenu();
    };
    document.addEventListener('pointerdown', onDoc, true);
    this.offDoc = () => document.removeEventListener('pointerdown', onDoc, true);
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
    this.offDoc?.();
    this.offDoc = null;
    this.presetBtn.setAttribute('aria-expanded', 'false');
  }

  private renderTip(x: number): void {
    if (this.hoverT === null) return;
    const col = evalPalette(this.p, this.hoverT);
    setText(this.tip, `t ${formatDisplay(this.hoverT, 2)}  ${rgbToHex(col)}`);
    toggle(this.tip, 'visible', true);
    const w = this.tip.offsetWidth;
    this.tip.style.left = `${Math.min(Math.max(0, x - w / 2), this.strip.w - w)}px`;
  }

  private render(): void {
    PALETTE_KEYS.forEach((key, ki) => {
      // An implicit coefficient (palette written without c) shows its value, read-only.
      const implicit = !!this.ctx.target.children?.[ki]?.implicit;
      this.inputs[ki].forEach((inp, ci) => (implicit ? inp.setLocked(formatDisplay(this.p[key][ci], 1)) : inp.set(this.p[key][ci])));
      toggle(this.rows[ki], 'implicit', implicit);
      const label = this.rows[ki].querySelector<HTMLElement>('.palette-key');
      if (label) label.title = implicit ? `${key} (${PALETTE_ROLES[key]}) is not written in the source: vec3(1.0). Write it to edit it.` : PALETTE_ROLES[key];
      const role = this.rows[ki].querySelector<HTMLElement>('.palette-role');
      if (role) setText(role, implicit ? 'implicit' : PALETTE_ROLES[key]);
      if (key === 'c') setText(this.formula, implicit ? 'a + b·cos(2π(t + d))' : 'a + b·cos(2π(c·t + d))');
      const sw = this.swatches[ki];
      const v = this.p[key];
      toggle(sw, 'hidden', key === 'c' || key === 'd');
      sw.style.background = cssRgb(v);
    });
    this.strip.invalidate();
    this.curves.invalidate();
  }

  private drawStrip(c: CanvasRenderingContext2D, w: number, hh: number): void {
    const t = theme();
    c.save();
    c.beginPath();
    c.roundRect(0, 0, w, hh, 4);
    c.clip();
    const n = Math.max(2, Math.ceil(w));
    for (let i = 0; i < n; i++) {
      c.fillStyle = cssRgb(evalPalette(this.p, i / (n - 1)));
      c.fillRect(i, 0, 1.5, hh);
    }
    c.restore();
    c.strokeStyle = withAlpha(t.fg, 0.18);
    c.beginPath();
    c.roundRect(0.5, 0.5, w - 1, hh - 1, 4);
    c.stroke();
    if (this.hoverT !== null) {
      const x = Math.round(this.hoverT * (w - 1)) + 0.5;
      c.strokeStyle = 'rgba(0,0,0,0.5)';
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(x, 1);
      c.lineTo(x, hh - 1);
      c.stroke();
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1;
      c.stroke();
    }
  }

  private drawCurves(c: CanvasRenderingContext2D, w: number, hh: number): void {
    const t = theme();
    const pad = 4;
    const Y = (v: number) => pad + (1 - Math.min(1.1, Math.max(-0.1, v))) * (hh - pad * 2);
    c.fillStyle = t.canvasBg;
    c.beginPath();
    c.roundRect(0.5, 0.5, w - 1, hh - 1, 4);
    c.fill();
    c.strokeStyle = withAlpha(t.fg, 0.14);
    c.stroke();
    c.setLineDash([2, 3]);
    c.strokeStyle = t.grid;
    c.beginPath();
    for (const v of [0, 0.5, 1]) {
      const y = Math.round(Y(v)) + 0.5;
      c.moveTo(1, y);
      c.lineTo(w - 1, y);
    }
    c.stroke();
    c.setLineDash([]);
    const n = Math.max(16, Math.ceil(w / 2));
    for (let ch = 0; ch < 3; ch++) {
      c.strokeStyle = withAlpha(t.axis[ch], 0.9);
      c.lineWidth = 1.5;
      c.beginPath();
      for (let i = 0; i <= n; i++) {
        const tt = i / n;
        const v = evalPalette(this.p, tt)[ch];
        const x = 1 + tt * (w - 2);
        if (i === 0) c.moveTo(x, Y(v));
        else c.lineTo(x, Y(v));
      }
      c.stroke();
    }
    c.lineWidth = 1;
    if (this.hoverT !== null) {
      const x = Math.round(1 + this.hoverT * (w - 2)) + 0.5;
      c.strokeStyle = withAlpha(t.fg, 0.4);
      c.beginPath();
      c.moveTo(x, 1);
      c.lineTo(x, hh - 1);
      c.stroke();
    }
  }

  update(ctx: WidgetContext): void {
    this.ctx = ctx;
    if (this.sessions.some((s) => s.dragging)) return;
    const p = paletteOf(ctx.target);
    if (p) this.p = p;
    this.render();
  }

  focus(): void {
    this.inputs[0][0].focus();
  }

  dispose(): void {
    this.closeMenu();
    for (const s of this.sessions) s.end(true);
    this.strip.dispose();
    this.curves.dispose();
  }
}
