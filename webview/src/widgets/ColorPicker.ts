// vec3/vec4 color mode: S/V square + hue strip (+ alpha strip for vec4),
// old|new swatch, hex field, R G B (A) inputs, HDR intensity for values > 1.

import { EditSession } from '../bridge';
import { clamp01, cssRgb, hsvToRgb, parseHex, rgbToHex, rgbToHsv, splitHdr, type HSV, type RGB } from '../math/color';
import { smartRange } from '../../../shared/valuesMath';
import { displayDecimals } from '../math/range';
import { expandedValues } from '../math/targets';
import { CanvasView, checker, theme } from '../ui/canvas';
import { h, setAttr, toggle } from '../ui/dom';
import { draggable } from '../ui/drag';
import { NumberInput, type Axis, type ChangePhase } from '../ui/NumberInput';
import { FloatControl, typedDecimals } from './FloatSlider';
import type { Widget, WidgetContext } from './types';

const DECIMALS = 3;

export class ColorPicker implements Widget {
  readonly el: HTMLElement;
  private session: EditSession;
  private ctx: WidgetContext;
  private hsv: HSV = { h: 0, s: 0, v: 0 };
  private alpha = 1;
  private k = 1;
  private readonly hasAlpha: boolean;
  private readonly original: number[];
  private sv: CanvasView;
  private hue: CanvasView;
  private alphaCv: CanvasView | null = null;
  private inputs: NumberInput[];
  private hex: HTMLInputElement;
  private oldSw: HTMLButtonElement;
  private newSw: HTMLElement;
  private intensity: FloatControl;
  private intensityRow: HTMLElement;
  private hdrMax = 1;
  /**
   * Exact component values of the target (not rounded, negatives kept). A
   * channel the gesture did not change is sent as this value (or null), so
   * buildReplacement keeps its source text: dragging alpha never rewrites
   * `0.8745` as `0.875`, a hue change never clamps an untouched `-0.1`.
   */
  private base: number[] = [];
  /** The user changed something since the last state from the extension (else show `base` as is). */
  private dirty = false;

  constructor(ctx: WidgetContext) {
    this.ctx = ctx;
    this.session = new EditSession(ctx.bridge, ctx.ref);
    this.hasAlpha = ctx.target.kind === 'vec4';
    this.original = expandedValues(ctx.target).slice(0, this.hasAlpha ? 4 : 3);

    this.sv = new CanvasView('sv-canvas', (c, w, hh) => this.drawSV(c, w, hh));
    this.hue = new CanvasView('hue-canvas', (c, w, hh) => this.drawHue(c, w, hh));
    this.sv.canvas.tabIndex = 0;
    this.sv.canvas.setAttribute('role', 'slider');
    this.sv.canvas.setAttribute('aria-label', 'Saturation and brightness');
    this.hue.canvas.tabIndex = 0;
    this.hue.canvas.setAttribute('role', 'slider');
    this.hue.canvas.setAttribute('aria-label', 'Hue');
    this.hue.canvas.setAttribute('aria-valuemin', '0');
    this.hue.canvas.setAttribute('aria-valuemax', '360');
    if (this.hasAlpha) {
      this.alphaCv = new CanvasView('alpha-canvas', (c, w, hh) => this.drawAlpha(c, w, hh));
      this.alphaCv.canvas.tabIndex = 0;
      this.alphaCv.canvas.setAttribute('role', 'slider');
      this.alphaCv.canvas.setAttribute('aria-label', 'Alpha');
    }

    const labels: [string, Axis][] = [
      ['R', 'x'],
      ['G', 'y'],
      ['B', 'z'],
      ['A', 'w'],
    ];
    this.inputs = labels.slice(0, this.hasAlpha ? 4 : 3).map(
      ([label, axis], i) =>
        new NumberInput({
          label,
          axis,
          name: ['red', 'green', 'blue', 'alpha'][i],
          step: () => 0.01,
          decimals: () => DECIMALS,
          displayDecimals: () => this.channelDecimals(i),
          change: (v, phase) => this.onComponent(i, v, phase),
        }),
    );

    this.hex = h('input.hex-input', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Hex color', maxlength: 9 });
    this.hex.addEventListener('focus', () => requestAnimationFrame(() => this.hex.select()));
    this.hex.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitHex();
        this.hex.select();
      } else if (e.key === 'Escape') {
        this.renderHex(true);
        this.hex.select();
      }
    });
    this.hex.addEventListener('blur', () => {
      this.commitHex();
      this.renderHex();
    });

    this.oldSw = h('button.swatch-old', { type: 'button', title: 'Original color: click to revert', 'aria-label': 'Revert to original color' });
    this.newSw = h('span.swatch-new', { title: 'Current color' });
    this.oldSw.addEventListener('click', () => {
      this.session.once(this.original, DECIMALS);
      this.fromValues(this.original);
    });
    const oldFill = h('span.swatch-fill');
    oldFill.style.background = cssRgb(splitHdr(this.original.slice(0, 3) as RGB).chroma, this.hasAlpha ? this.original[3] : 1);
    this.oldSw.append(oldFill);
    this.newSw.append(h('span.swatch-fill'));

    this.intensity = new FloatControl({
      name: 'Intensity',
      label: 'Intensity',
      session: this.session,
      values: () => [],
      index: 0,
      fixedRange: () => ({ min: 0, max: this.hdrMax }),
      compact: true,
      onChange: (v, phase) => {
        this.k = Math.max(0, v);
        this.emit(phase);
      },
    });
    this.intensityRow = h('div.intensity-row', null, this.intensity.el);

    const svWrap = h('div.sv-wrap', null, this.sv.canvas, h('div.hue-wrap', null, this.hue.canvas));
    this.el = h(
      'div.w-color',
      null,
      svWrap,
      this.alphaCv ? h('div.alpha-wrap', null, this.alphaCv.canvas) : null,
      this.intensityRow,
      h('div.color-line', null, h('span.swatch-pair', null, this.oldSw, this.newSw), h('label.hex-field', null, h('span.hex-hash', { 'aria-hidden': 'true' }, '#'), this.hex)),
      h(`div.inputs.cols-${this.inputs.length}`, null, ...this.inputs.map((i) => i.el)),
    );
    this.wire();
    this.update(ctx);
  }

  private rgb(): RGB {
    const c = hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v);
    return [c[0] * this.k, c[1] * this.k, c[2] * this.k];
  }

  /** Snaps a channel to its exact source value when it rounds to it at the write precision. */
  private keep(x: number, i: number): number {
    const b = this.base[i];
    if (Number.isFinite(b) && Math.abs(x - b) < 0.5 * 10 ** -DECIMALS) return b;
    return Number(x.toFixed(DECIMALS));
  }

  /** Current values for display and comparisons (untouched channels exact). */
  private values(): number[] {
    if (!this.dirty && this.base.length >= (this.hasAlpha ? 4 : 3)) return this.base.slice(0, this.hasAlpha ? 4 : 3);
    const r = this.rgb().map((x, i) => this.keep(x, i));
    return this.hasAlpha ? [...r, this.keep(this.alpha, 3)] : r;
  }

  /**
   * Edit payload. `color`: the RGB channels (alpha untouched), `alpha`: only
   * alpha, `all`: everything. Untouched channels are null.
   */
  private payload(what: 'color' | 'alpha' | 'all'): (number | null)[] {
    const v = this.values();
    const out: (number | null)[] = v.slice(0, 3).map((x) => (what === 'alpha' ? null : x));
    if (this.hasAlpha) out.push(what === 'color' ? null : v[3]);
    return out;
  }

  /** Display decimals of channel i: the literal's own precision (more only while a value needs it). */
  private channelDecimals(i: number): number {
    const t = this.ctx.target;
    const c = t.components[t.splat ? 0 : i];
    return displayDecimals(c?.text, c?.integer);
  }

  private emit(phase: ChangePhase, what: 'color' | 'alpha' | 'all' = 'color'): void {
    if (phase !== 'dragStart' && phase !== 'dragEnd' && phase !== 'dragCancel') this.dirty = true;
    const vals = this.payload(what);
    switch (phase) {
      case 'dragStart':
        this.session.start();
        break;
      case 'drag':
        this.session.move(vals, DECIMALS);
        break;
      case 'dragEnd':
        this.session.end(true);
        break;
      case 'dragCancel':
        this.session.end(false);
        break;
      case 'key':
        this.session.key(vals, DECIMALS);
        break;
      case 'commit':
        this.session.once(vals, DECIMALS);
        break;
    }
    this.render();
  }

  private wire(): void {
    const sv = this.sv;
    let startVals: number[] = [];
    const svDrag = (e: PointerEvent) => {
      const p = sv.local(e);
      this.hsv = { ...this.hsv, s: clamp01(p.x / sv.w), v: clamp01(1 - p.y / sv.h) };
      this.emit('drag');
    };
    const begin = (cv: CanvasView) => () => {
      cv.canvas.focus({ preventScroll: true });
      startVals = this.base.slice();
      this.session.start();
    };
    const end = () => (_e: PointerEvent | null, cancelled: boolean) => {
      if (cancelled) {
        this.session.end(false);
        this.fromValues(startVals);
        this.dirty = false;
      } else this.session.end(true);
      this.render();
    };
    draggable(sv.canvas, {
      start: (e) => {
        if (e.button !== 0) return false;
        begin(sv)();
        svDrag(e);
      },
      move: svDrag,
      end: end(),
    });
    const hueDrag = (e: PointerEvent) => {
      const p = this.hue.local(e);
      this.hsv = { ...this.hsv, h: Math.min(359.999, Math.max(0, (p.y / this.hue.h) * 360)) };
      this.emit('drag');
    };
    draggable(this.hue.canvas, {
      start: (e) => {
        if (e.button !== 0) return false;
        begin(this.hue)();
        hueDrag(e);
      },
      move: hueDrag,
      end: end(),
    });
    if (this.alphaCv) {
      const acv = this.alphaCv;
      const aDrag = (e: PointerEvent) => {
        this.alpha = clamp01(acv.local(e).x / acv.w);
        this.emit('drag', 'alpha');
      };
      draggable(acv.canvas, {
        start: (e) => {
          if (e.button !== 0) return false;
          begin(acv)();
          aDrag(e);
        },
        move: aDrag,
        end: end(),
      });
      acv.canvas.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        this.alpha = clamp01(this.alpha + d * (e.shiftKey ? 0.1 : 0.01));
        this.emit('key', 'alpha');
      });
    }
    sv.canvas.addEventListener('keydown', (e) => {
      const st = e.shiftKey ? 0.1 : 0.01;
      let { s, v } = this.hsv;
      if (e.key === 'ArrowLeft') s -= st;
      else if (e.key === 'ArrowRight') s += st;
      else if (e.key === 'ArrowUp') v += st;
      else if (e.key === 'ArrowDown') v -= st;
      else return;
      e.preventDefault();
      e.stopPropagation();
      this.hsv = { ...this.hsv, s: clamp01(s), v: clamp01(v) };
      this.emit('key');
    });
    this.hue.canvas.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      this.hsv = { ...this.hsv, h: (this.hsv.h + d * (e.shiftKey ? 10 : 1) + 360) % 360 };
      this.emit('key');
    });
  }

  private onComponent(i: number, v: number, phase: ChangePhase): void {
    // Only the typed / scrubbed channel is written; the others keep their text.
    const vals: (number | null)[] = this.values().map(() => null);
    vals[i] = v;
    if (phase === 'dragStart') {
      this.session.start();
      return;
    }
    const merged = this.values();
    merged[i] = v;
    this.fromValues(merged);
    this.dirty = true;
    if (phase === 'commit') this.session.once(vals, Math.max(DECIMALS, typedDecimals(v)));
    else if (phase === 'key') this.session.key(vals, DECIMALS);
    else if (phase === 'drag') this.session.move(vals, DECIMALS);
    else if (phase === 'dragEnd') this.session.end(true);
    else if (phase === 'dragCancel') this.session.end(false);
    this.render();
  }

  private commitHex(): void {
    const raw = this.hex.value.trim();
    if (!raw || raw.replace(/^#/, '').toUpperCase() === this.hexText()) return;
    const p = parseHex(raw);
    if (!p) {
      this.hex.classList.add('invalid');
      setTimeout(() => this.hex.classList.remove('invalid'), 400);
      return;
    }
    // Keep the HDR intensity: the hex field shows (and edits) the chroma.
    this.hsv = rgbToHsv(p.rgb, this.hsv);
    if (p.alpha !== undefined && this.hasAlpha) this.alpha = p.alpha;
    this.emit('commit', p.alpha !== undefined && this.hasAlpha ? 'all' : 'color');
  }

  private hexText(): string {
    const { chroma } = splitHdr(this.rgb());
    return rgbToHex(chroma, this.hasAlpha && this.alpha < 1 ? this.alpha : undefined).slice(1);
  }

  private renderHex(force = false): void {
    if (!force && document.activeElement === this.hex) return;
    const t = this.hexText();
    if (this.hex.value !== t) this.hex.value = t;
  }

  /** Sets internal HSV/alpha/intensity from component values, keeping hue stable for greys. */
  private fromValues(vals: number[]): void {
    const rgb: RGB = [vals[0], vals[1], vals[2]].map((x) => (Number.isFinite(x) ? Math.max(0, x) : 0)) as RGB;
    const { chroma, k } = splitHdr(rgb);
    this.k = k;
    if (k > 1) this.hdrMax = Math.max(this.hdrMax, smartRange(k).max);
    this.hsv = rgbToHsv(chroma, this.hsv);
    if (this.hasAlpha) this.alpha = clamp01(Number.isFinite(vals[3]) ? vals[3] : 1);
  }

  private render(): void {
    const vals = this.values();
    this.inputs.forEach((inp, i) => inp.set(vals[i]));
    this.renderHex();
    const rgb = this.rgb();
    (this.newSw.firstElementChild as HTMLElement).style.background = cssRgb(splitHdr(rgb).chroma, this.hasAlpha ? this.alpha : 1);
    const hdr = this.k > 1 || this.hdrMax > 1;
    toggle(this.intensityRow, 'hidden', !hdr);
    if (hdr) this.intensity.set(Number(this.k.toFixed(DECIMALS)));
    setAttr(this.sv.canvas, 'aria-valuetext', `saturation ${Math.round(this.hsv.s * 100)}%, brightness ${Math.round(this.hsv.v * 100)}%`);
    setAttr(this.hue.canvas, 'aria-valuenow', Math.round(this.hsv.h));
    setAttr(this.hue.canvas, 'aria-valuetext', `${Math.round(this.hsv.h)} degrees`);
    if (this.alphaCv) setAttr(this.alphaCv.canvas, 'aria-valuetext', `${Math.round(this.alpha * 100)}%`);
    this.sv.invalidate();
    this.hue.invalidate();
    this.alphaCv?.invalidate();
  }

  private drawSV(c: CanvasRenderingContext2D, w: number, hh: number): void {
    const t = theme();
    c.save();
    c.beginPath();
    c.roundRect(0, 0, w, hh, 4);
    c.clip();
    c.fillStyle = cssRgb(hsvToRgb(this.hsv.h, 1, 1));
    c.fillRect(0, 0, w, hh);
    const gw = c.createLinearGradient(0, 0, w, 0);
    gw.addColorStop(0, 'rgba(255,255,255,1)');
    gw.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = gw;
    c.fillRect(0, 0, w, hh);
    const gb = c.createLinearGradient(0, 0, 0, hh);
    gb.addColorStop(0, 'rgba(0,0,0,0)');
    gb.addColorStop(1, 'rgba(0,0,0,1)');
    c.fillStyle = gb;
    c.fillRect(0, 0, w, hh);
    c.restore();
    if (t.highContrast) {
      c.strokeStyle = t.fg;
      c.strokeRect(0.5, 0.5, w - 1, hh - 1);
    }
    const mr = 6;
    marker(c, Math.min(w - mr - 1, Math.max(mr + 1, this.hsv.s * w)), Math.min(hh - mr - 1, Math.max(mr + 1, (1 - this.hsv.v) * hh)), mr);
  }

  private drawHue(c: CanvasRenderingContext2D, w: number, hh: number): void {
    c.save();
    c.beginPath();
    c.roundRect(0, 0, w, hh, 4);
    c.clip();
    const g = c.createLinearGradient(0, 0, 0, hh);
    for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, cssRgb(hsvToRgb(i * 60, 1, 1)));
    c.fillStyle = g;
    c.fillRect(0, 0, w, hh);
    c.restore();
    const y = Math.min(hh - 3, Math.max(3, (this.hsv.h / 360) * hh));
    bar(c, 1, y - 3, w - 2, 6);
  }

  private drawAlpha(c: CanvasRenderingContext2D, w: number, hh: number): void {
    c.save();
    c.beginPath();
    c.roundRect(0, 0, w, hh, 3);
    c.clip();
    checker(c, 0, 0, w, hh, 4);
    const base = hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v);
    const g = c.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, cssRgb(base, 0));
    g.addColorStop(1, cssRgb(base, 1));
    c.fillStyle = g;
    c.fillRect(0, 0, w, hh);
    c.restore();
    const x = Math.min(w - 3, Math.max(3, this.alpha * w));
    bar(c, x - 3, 1, 6, hh - 2);
  }

  update(ctx: WidgetContext): void {
    this.ctx = ctx;
    this.session.ref = ctx.ref;
    if (this.session.dragging) return;
    const vals = expandedValues(ctx.target);
    this.base = vals.slice();
    // Keep the internal HSV when it already produces these values (no hue drift on greys).
    this.dirty = true;
    const cur = this.values();
    this.dirty = false;
    const same = vals.slice(0, cur.length).every((v, i) => Math.abs(v - cur[i]) < 5e-4);
    if (!same) this.fromValues(vals);
    this.render();
  }

  focus(): void {
    this.sv.canvas.focus();
  }

  dispose(): void {
    this.session.end(true);
    this.sv.dispose();
    this.hue.dispose();
    this.alphaCv?.dispose();
  }
}

/** Ring marker readable on any color: white ring with a dark outer ring. */
function marker(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(0,0,0,0.45)';
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.stroke();
  c.lineWidth = 2;
  c.strokeStyle = '#ffffff';
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.stroke();
}

function bar(c: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number): void {
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(0,0,0,0.45)';
  c.beginPath();
  c.roundRect(x, y, w, hh, 2);
  c.stroke();
  c.lineWidth = 2;
  c.strokeStyle = '#ffffff';
  c.beginPath();
  c.roundRect(x, y, w, hh, 2);
  c.stroke();
}
