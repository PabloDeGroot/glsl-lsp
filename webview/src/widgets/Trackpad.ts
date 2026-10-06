// vec2 -> 2D trackpad: grid, axes through 0, guides, draggable point.
// Shift = fine, Ctrl = snap to grid, Ctrl+wheel = zoom, double-click = reset.

import { clamp, formatDisplay, snap } from '../../../shared/valuesMath';
import { EditSession } from '../bridge';
import { withAlpha } from '../math/color';
import { displayDecimals, extendRange, fromFraction, modifierFactor, stepsFor, toFraction, vec2Range, zoomRange, type NumRange } from '../math/range';
import { expandedValues } from '../math/targets';
import { CanvasView, px, theme } from '../ui/canvas';
import { h, iconButton, setAttr, setText, toggle } from '../ui/dom';
import { draggable } from '../ui/drag';
import { NumberInput, type ChangePhase } from '../ui/NumberInput';
import { showRangeSource, typedDecimals } from './FloatSlider';
import type { Widget, WidgetContext } from './types';

/** Grab radius (CSS px) around the handle. */
const HANDLE_R = 10;

export class Trackpad implements Widget {
  readonly el: HTMLElement;
  private cv: CanvasView;
  private session: EditSession;
  private ctx: WidgetContext;
  private v: [number, number];
  /** Reset point of the target (per target, survives widget rebuilds). */
  private get initial(): number[] {
    return this.ctx.resetPoint(this.ctx.target);
  }
  private auto: NumRange | null = null;
  private hover = false;
  /** Shift (fine) drag in progress: write one more decimal. */
  private fine = false;
  private inputs: NumberInput[];
  private minInput: NumberInput;
  private maxInput: NumberInput;
  private caption: HTMLElement;
  private resetRange: HTMLButtonElement;

  constructor(ctx: WidgetContext) {
    this.ctx = ctx;
    this.session = new EditSession(ctx.bridge, ctx.ref);
    const e = expandedValues(ctx.target);
    this.v = [e[0], e[1]];
    this.cv = new CanvasView('pad-canvas', (c, w, h) => this.draw(c, w, h));
    const cvs = this.cv.canvas;
    cvs.tabIndex = 0;
    cvs.setAttribute('role', 'slider');
    cvs.setAttribute('aria-label', `${ctx.target.name ?? 'vec2'} trackpad`);
    cvs.setAttribute('aria-roledescription', '2D slider');

    this.inputs = (['x', 'y'] as const).map(
      (axis, i) =>
        new NumberInput({
          label: axis.toUpperCase(),
          axis,
          name: axis,
          step: () => this.steps().drag,
          decimals: () => this.steps().decimals,
          displayDecimals: () => {
            const t = this.ctx.target;
            const c = t.components[t.splat ? 0 : i];
            return displayDecimals(c?.text, c?.integer);
          },
          change: (val, phase) => this.onInput(i, val, phase),
        }),
    );
    const mk = (which: 'min' | 'max') =>
      new NumberInput({
        name: `Range ${which}`,
        size: 'sm',
        step: () => this.steps().key,
        decimals: () => Math.max(1, this.steps().decimals - 1),
        displayDecimals: () => 0,
        change: (val, phase) => {
          if (phase !== 'commit' && phase !== 'key') return;
          const r = this.range();
          const next = which === 'min' ? { min: val, max: r.max } : { min: r.min, max: val };
          if (next.max > next.min) this.ctx.setOptions({ range: next });
          this.sync();
        },
      });
    this.minInput = mk('min');
    this.maxInput = mk('max');
    this.caption = h('span.range-caption');
    this.resetRange = iconButton('reset', 'Reset range', { title: 'Back to the automatic range', cls: 'tiny' });
    this.resetRange.addEventListener('click', () => {
      this.auto = null;
      this.ctx.setOptions({ range: undefined });
      this.sync();
    });

    this.el = h(
      'div.w-trackpad',
      null,
      h('div.canvas-wrap', null, cvs),
      h('div.range-line', null, this.minInput.el, h('span.range-mid', null, this.caption, this.resetRange), this.maxInput.el),
      h('div.inputs.cols-2', null, ...this.inputs.map((i) => i.el)),
    );
    this.wire();
    this.update(ctx);
  }

  private range(): NumRange {
    const r = vec2Range(this.v[0], this.v[1], this.ctx.target.uniform, this.ctx.options);
    if (r.source !== 'auto') return r;
    if (!this.auto) this.auto = { min: r.min, max: r.max };
    else {
      this.auto = extendRange(this.auto, this.v[0]);
      this.auto = extendRange(this.auto, this.v[1]);
    }
    return this.auto;
  }

  private steps() {
    return stepsFor(this.range(), { uniformStep: this.ctx.target.uniform?.step });
  }

  private wire(): void {
    const cvs = this.cv.canvas;
    let fine = false;
    let anchor = { x: 0, y: 0, v: [0, 0] as [number, number] };
    let start: [number, number] = [0, 0];
    /** Pointer-to-handle offset when the handle itself was grabbed (no jump). */
    let grab = { x: 0, y: 0 };
    let jumpedAt = -Infinity;
    const pad = 8;
    const toValue = (e: PointerEvent): [number, number] => {
      const raw = this.cv.local(e);
      const p = { x: raw.x - grab.x, y: raw.y - grab.y };
      const r = this.range();
      const size = this.cv.w - pad * 2;
      const s = this.steps();
      if (e.shiftKey !== fine) {
        fine = e.shiftKey;
        anchor = { x: p.x, y: p.y, v: [this.v[0], this.v[1]] };
      }
      let x: number;
      let y: number;
      if (fine) {
        const k = ((r.max - r.min) / size) * 0.1;
        x = anchor.v[0] + (p.x - anchor.x) * k;
        y = anchor.v[1] - (p.y - anchor.y) * k;
      } else {
        x = fromFraction((p.x - pad) / size, r);
        y = fromFraction(1 - (p.y - pad) / size, r);
      }
      this.fine = fine;
      const step = e.ctrlKey ? (r.max - r.min) / 10 : fine ? s.drag / 10 : s.drag;
      return [clamp(snap(x, step), r.min, r.max), clamp(snap(y, step), r.min, r.max)];
    };
    draggable(cvs, {
      start: (e) => {
        if (e.button !== 0) return false;
        cvs.focus({ preventScroll: true });
        fine = false;
        start = [this.v[0], this.v[1]];
        this.session.start();
        // Grabbing the handle (or the second press of a double-click) keeps the value:
        // drag relative to where it was taken. Elsewhere the point jumps to the press.
        const p = this.cv.local(e);
        const hp = this.handlePos();
        if (Math.hypot(p.x - hp.x, p.y - hp.y) <= HANDLE_R || e.detail >= 2) {
          grab = { x: p.x - hp.x, y: p.y - hp.y };
        } else {
          grab = { x: 0, y: 0 };
          jumpedAt = performance.now();
          this.set(toValue(e), 'drag');
        }
      },
      move: (e) => this.set(toValue(e), 'drag'),
      end: (_e, cancelled) => {
        if (cancelled) {
          this.v = start;
          this.session.end(false);
        } else this.session.end(true);
        this.sync();
      },
    });
    cvs.addEventListener('pointerenter', () => {
      this.hover = true;
      this.cv.invalidate();
    });
    cvs.addEventListener('pointerleave', () => {
      this.hover = false;
      this.cv.invalidate();
    });
    cvs.addEventListener('dblclick', (e) => {
      // Reset from the handle only, and not after the first click jumped there.
      const p = this.cv.local(e as PointerEvent);
      const hp = this.handlePos();
      if (Math.hypot(p.x - hp.x, p.y - hp.y) > HANDLE_R || performance.now() - jumpedAt < 700) return;
      if (this.v[0] === this.initial[0] && this.v[1] === this.initial[1]) return;
      this.v = [this.initial[0], this.initial[1]];
      this.session.once([...this.v], this.steps().decimals);
      this.sync();
    });
    cvs.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const next = zoomRange(this.range(), e.deltaY > 0 ? 2 : 0.5);
        this.auto = null;
        this.ctx.setOptions({ range: next });
        this.sync();
      },
      { passive: false },
    );
    cvs.addEventListener('keydown', (e) => {
      const map: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      const d = map[e.key];
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      const r = this.range();
      const s = this.steps();
      const k = s.key * modifierFactor(e);
      const step = e.altKey ? s.drag / 10 : s.drag;
      const next: [number, number] = [clamp(snap(this.v[0] + d[0] * k, step), r.min, r.max), clamp(snap(this.v[1] + d[1] * k, step), r.min, r.max)];
      this.set(next, 'key');
    });
  }

  /** Canvas position (CSS px) of the handle. */
  private handlePos(): { x: number; y: number } {
    const pad = 8;
    const size = Math.min(this.cv.w, this.cv.h) - pad * 2;
    const r = this.range();
    return {
      x: pad + toFraction(clamp(this.v[0], r.min, r.max), r) * size,
      y: pad + (1 - toFraction(clamp(this.v[1], r.min, r.max), r)) * size,
    };
  }

  private set(v: [number, number], phase: 'drag' | 'key'): void {
    if (v[0] === this.v[0] && v[1] === this.v[1] && phase === 'drag') return;
    this.v = v;
    const d = this.steps().decimals;
    if (phase === 'drag') this.session.move([...v], d + (this.fine ? 1 : 0));
    else this.session.key([...v], d);
    this.sync();
  }

  private onInput(i: number, val: number, phase: ChangePhase): void {
    const next: [number, number] = [this.v[0], this.v[1]];
    next[i] = val;
    this.v = next;
    const d = this.steps().decimals;
    switch (phase) {
      case 'commit': {
        const r = this.range();
        if ((val < r.min || val > r.max) && this.ctx.target.uniform?.min === undefined) this.auto = extendRange(r, val);
        this.session.once([...next], typedDecimals(val));
        break;
      }
      case 'key':
        this.session.key([...next], d);
        break;
      case 'dragStart':
        this.session.start();
        break;
      case 'drag':
        this.session.move([...next], d);
        break;
      case 'dragEnd':
        this.session.end(true);
        break;
      case 'dragCancel':
        this.session.end(false);
        break;
    }
    this.sync();
  }

  private sync(): void {
    const r = this.range();
    const d = this.steps().decimals;
    this.inputs[0].set(this.v[0]);
    this.inputs[1].set(this.v[1]);
    const rd = Math.max(1, Math.min(4, d - 1));
    this.minInput.set(Number(r.min.toFixed(rd)));
    this.maxInput.set(Number(r.max.toFixed(rd)));
    const src = vec2Range(this.v[0], this.v[1], this.ctx.target.uniform, this.ctx.options).source;
    showRangeSource(this.caption, [this.minInput, this.maxInput], src, ' · Ctrl+wheel zooms');
    toggle(this.resetRange, 'hidden', src !== 'user');
    const cvs = this.cv.canvas;
    setAttr(cvs, 'aria-valuetext', `x ${formatDisplay(this.v[0], d)}, y ${formatDisplay(this.v[1], d)}`);
    this.cv.invalidate();
  }

  private draw(c: CanvasRenderingContext2D, w: number, hgt: number): void {
    const t = theme();
    const pad = 8;
    const size = Math.min(w, hgt) - pad * 2;
    const r = this.range();
    const X = (v: number) => pad + toFraction(v, r) * size;
    const Y = (v: number) => pad + (1 - toFraction(v, r)) * size;

    c.fillStyle = t.canvasBg;
    c.beginPath();
    c.roundRect(0.5, 0.5, w - 1, hgt - 1, 4);
    c.fill();
    c.strokeStyle = withAlpha(t.fg, 0.14);
    c.lineWidth = 1;
    c.stroke();

    // grid
    c.strokeStyle = t.grid;
    c.beginPath();
    for (let i = 0; i <= 10; i++) {
      const p = px(pad + (size * i) / 10);
      c.moveTo(p, pad);
      c.lineTo(p, pad + size);
      c.moveTo(pad, p);
      c.lineTo(pad + size, p);
    }
    c.stroke();
    // axes through 0
    if (r.min < 0 && r.max > 0) {
      c.lineWidth = 1;
      c.strokeStyle = withAlpha(t.axis[0], 0.55);
      c.beginPath();
      c.moveTo(pad, px(Y(0)));
      c.lineTo(pad + size, px(Y(0)));
      c.stroke();
      c.strokeStyle = withAlpha(t.axis[1], 0.55);
      c.beginPath();
      c.moveTo(px(X(0)), pad);
      c.lineTo(px(X(0)), pad + size);
      c.stroke();
    }
    const vx = X(clamp(this.v[0], r.min, r.max));
    const vy = Y(clamp(this.v[1], r.min, r.max));
    // guides
    c.setLineDash([2, 3]);
    c.strokeStyle = withAlpha(t.fg, 0.35);
    c.beginPath();
    const ox = r.min < 0 && r.max > 0 ? X(0) : pad;
    const oy = r.min < 0 && r.max > 0 ? Y(0) : pad + size;
    c.moveTo(px(vx), px(vy));
    c.lineTo(px(vx), px(oy));
    c.moveTo(px(vx), px(vy));
    c.lineTo(px(ox), px(vy));
    c.stroke();
    c.setLineDash([]);

    // point
    const big = this.hover || this.session.dragging;
    const rr = big ? 7 : 6;
    c.fillStyle = withAlpha(t.accent, 0.22);
    c.beginPath();
    c.arc(vx, vy, rr + 4, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = t.accent;
    c.beginPath();
    c.arc(vx, vy, rr, 0, Math.PI * 2);
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = t.canvasBg;
    c.stroke();
    c.lineWidth = 1;
    c.strokeStyle = t.fg;
    c.beginPath();
    c.arc(vx, vy, rr + 1.5, 0, Math.PI * 2);
    c.stroke();
  }

  update(ctx: WidgetContext): void {
    this.ctx = ctx;
    this.session.ref = ctx.ref;
    if (this.session.dragging) return;
    const e = expandedValues(ctx.target);
    this.v = [e[0], e[1]];
    this.sync();
  }

  focus(): void {
    this.cv.canvas.focus();
  }

  dispose(): void {
    this.session.end(true);
    this.cv.dispose();
  }
}

function short(v: number): string {
  return Number(v.toPrecision(3)).toString();
}
