// vec3/vec4 vector mode: trackball direction picker. Drag rotates the vector
// to the sphere point under the pointer (dragging past the silhouette wraps
// onto the back); Alt/middle/right drag orbits the view; Shift snaps 15deg,
// Ctrl snaps to axes/diagonals. Keep length / Normalize; W slider for vec4.

import { formatDisplay } from '../../../shared/valuesMath';
import { EditSession } from '../bridge';
import { withAlpha } from '../math/color';
import { displayDecimals } from '../math/range';
import { expandedValues } from '../math/targets';
import {
  DEFAULT_VIEW,
  DEG,
  discToSphere,
  fromView,
  len,
  normalize,
  rotateAround,
  scale,
  snapAngles,
  snapDiagonal,
  toView,
  type V3,
  type View,
} from '../math/vec';
import { CanvasView, theme } from '../ui/canvas';
import { h, setAttr, setText, toggle } from '../ui/dom';
import { draggable } from '../ui/drag';
import { NumberInput, type Axis, type ChangePhase } from '../ui/NumberInput';
import { FloatControl, typedDecimals } from './FloatSlider';
import type { Widget, WidgetContext } from './types';
import { iconEl } from '../icons';

const DECIMALS = 3;

/** Grab radius (CSS px) around the vector tip. */
const HANDLE_R = 10;

export class Trackball implements Widget {
  readonly el: HTMLElement;
  private session: EditSession;
  private ctx: WidgetContext;
  private v: V3;
  private w = 0;
  private readonly hasW: boolean;
  /** Reset point of the target (per target, survives widget rebuilds). */
  private get initial(): number[] {
    return this.ctx.resetPoint(this.ctx.target);
  }
  private view: View;
  private cv: CanvasView;
  private inputs: NumberInput[];
  private lenText: HTMLElement;
  private keep: HTMLInputElement;
  private hint: HTMLElement;
  private wCtl: FloatControl | null = null;
  private hover = false;

  constructor(ctx: WidgetContext) {
    this.ctx = ctx;
    this.session = new EditSession(ctx.bridge, ctx.ref);
    this.hasW = ctx.target.kind === 'vec4';
    const e = expandedValues(ctx.target);
    this.v = [e[0], e[1], e[2]];
    this.w = e[3] ?? 0;
    this.view = ctx.ui.data.views[ctx.key] ?? { ...DEFAULT_VIEW };

    this.cv = new CanvasView('ball-canvas', (c, w, hh) => this.draw(c, w, hh));
    const cvs = this.cv.canvas;
    cvs.tabIndex = 0;
    cvs.setAttribute('role', 'slider');
    cvs.setAttribute('aria-roledescription', 'direction picker');
    cvs.setAttribute('aria-label', `${ctx.target.name ?? 'vector'} direction. Arrows rotate; Alt+drag orbits the view`);

    const axes: Axis[] = ['x', 'y', 'z'];
    this.inputs = axes.map(
      (axis, i) =>
        new NumberInput({
          label: axis.toUpperCase(),
          axis,
          name: axis,
          step: () => 0.01,
          decimals: () => DECIMALS,
          displayDecimals: () => {
            const t = this.ctx.target;
            const c = t.components[t.splat ? 0 : i];
            return displayDecimals(c?.text, c?.integer);
          },
          change: (val, phase) => this.onInput(i, val, phase),
        }),
    );

    this.lenText = h('span.len-readout');
    this.keep = h('input.checkbox', { type: 'checkbox', id: `keep-${ctx.key.replace(/[^\w-]/g, '_')}` });
    this.keep.addEventListener('change', () => this.ctx.setOptions({ keepLength: this.keep.checked }));
    const keepLabel = h('label.check', { title: 'Keep the vector length while rotating (off: write unit vectors)' }, this.keep, h('span', null, 'Keep length'));
    const normalizeBtn = h('button.button.secondary.small', { type: 'button', title: 'Scale to length 1', 'aria-label': 'Normalize' }, iconEl('normalize'), h('span.button-label', null, 'Normalize'));
    normalizeBtn.addEventListener('click', () => {
      this.v = normalize(this.v);
      this.session.once(this.values(), DECIMALS);
      this.sync();
    });
    this.hint = h('div.widget-hint.zero-hint', null, 'Zero vector: drag to set a direction');

    if (this.hasW) {
      this.wCtl = new FloatControl({
        name: 'w',
        label: 'W',
        axis: 'w',
        session: this.session,
        values: () => this.values(),
        index: 3,
        compact: true,
        userRange: () => undefined,
        resetValue: () => this.initial[3],
      });
    }

    this.el = h(
      'div.w-vector',
      null,
      h('div.canvas-wrap', null, cvs),
      h('div.vector-meta', null, this.lenText, keepLabel, normalizeBtn),
      this.hint,
      this.wCtl?.el ?? null,
      h('div.inputs.cols-3', null, ...this.inputs.map((i) => i.el)),
    );
    this.wire();
    this.update(ctx);
  }

  private values(): number[] {
    const r = this.v.map((x) => Number(x.toFixed(DECIMALS)));
    return this.hasW ? [...r, this.w] : r;
  }

  private keepLength(): boolean {
    return this.ctx.options.keepLength ?? true;
  }

  private geometry() {
    const w = this.cv.w;
    const hh = this.cv.h;
    const R = Math.max(10, Math.min(w, hh) / 2 - 20);
    return { cx: w / 2, cy: hh / 2, R };
  }

  private wire(): void {
    const cvs = this.cv.canvas;
    let mode: 'rotate' | 'orbit' = 'rotate';
    let front = true;
    let last = { x: 0, y: 0 };
    let start: V3 = [0, 0, 1];
    let L = 1;
    /** Pointer-to-tip offset when the tip itself was grabbed (no jump). */
    let grab = { x: 0, y: 0 };
    let jumpedAt = -Infinity;
    const pick = (e: PointerEvent) => {
      const raw = this.cv.local(e);
      const p = { x: raw.x - grab.x, y: raw.y - grab.y };
      const { cx, cy, R } = this.geometry();
      const d = discToSphere((p.x - cx) / R, -(p.y - cy) / R, front);
      let u = fromView(d, this.view);
      if (e.ctrlKey) u = snapDiagonal(u);
      else if (e.shiftKey) u = snapAngles(u, 15);
      this.v = scale(u, L);
      this.session.move(this.values(), DECIMALS);
      this.sync();
    };
    cvs.addEventListener('contextmenu', (e) => e.preventDefault());
    draggable(cvs, {
      start: (e) => {
        cvs.focus({ preventScroll: true });
        last = { x: e.clientX, y: e.clientY };
        mode = e.altKey || e.button === 1 || e.button === 2 ? 'orbit' : 'rotate';
        if (mode === 'rotate') {
          start = [...this.v] as V3;
          const l = len(this.v);
          L = this.keepLength() && l > 1e-9 ? l : 1;
          front = toView(normalize(this.v), this.view)[2] >= 0;
          this.session.start();
          // Grabbing the tip (or the second press of a double-click) keeps the vector until it moves.
          const p = this.cv.local(e);
          const tip = this.tipPos();
          if (Math.hypot(p.x - tip.x, p.y - tip.y) <= HANDLE_R || e.detail >= 2) {
            grab = { x: p.x - tip.x, y: p.y - tip.y };
          } else {
            grab = { x: 0, y: 0 };
            jumpedAt = performance.now();
            pick(e);
          }
        }
      },
      move: (e) => {
        if (mode === 'orbit') {
          this.view = {
            yaw: this.view.yaw + (e.clientX - last.x) * 0.01,
            pitch: Math.max(-89 * DEG, Math.min(89 * DEG, this.view.pitch + (e.clientY - last.y) * 0.01)),
          };
          last = { x: e.clientX, y: e.clientY };
          this.saveView();
          this.cv.invalidate();
        } else pick(e);
      },
      end: (_e, cancelled) => {
        if (mode === 'rotate') {
          if (cancelled) this.v = start;
          this.session.end(!cancelled);
          this.sync();
        }
      },
    });
    cvs.addEventListener('dblclick', (e) => {
      const p = this.cv.local(e);
      const { cx, cy, R } = this.geometry();
      const tip = this.tipPos();
      if (Math.hypot(p.x - tip.x, p.y - tip.y) <= HANDLE_R && performance.now() - jumpedAt >= 700) {
        // Reset from the tip only (a double-click elsewhere first jumped the vector there).
        if (this.v.every((x, i) => x === this.initial[i])) return;
        this.v = [this.initial[0], this.initial[1], this.initial[2]];
        this.session.once(this.values(), DECIMALS);
        this.sync();
      } else if (Math.hypot(p.x - cx, p.y - cy) > R) {
        this.view = { ...DEFAULT_VIEW };
        this.saveView();
        this.cv.invalidate();
      }
    });
    cvs.addEventListener('pointerenter', () => {
      this.hover = true;
      this.cv.invalidate();
    });
    cvs.addEventListener('pointerleave', () => {
      this.hover = false;
      this.cv.invalidate();
    });
    cvs.addEventListener('keydown', (e) => {
      const deg = e.shiftKey ? 15 : e.altKey ? 1 : 5;
      let axis: V3 | null = null;
      let sign = 1;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        axis = fromView([0, 1, 0], this.view);
        sign = e.key === 'ArrowRight' ? 1 : -1;
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        axis = fromView([1, 0, 0], this.view);
        sign = e.key === 'ArrowUp' ? -1 : 1;
      }
      if (!axis) return;
      e.preventDefault();
      e.stopPropagation();
      const base: V3 = len(this.v) > 1e-9 ? this.v : [0, 0, 1];
      this.v = rotateAround(base, axis, sign * deg * DEG);
      this.session.key(this.values(), DECIMALS);
      this.sync();
    });
  }

  /** Canvas position (CSS px) of the vector tip. */
  private tipPos(): { x: number; y: number } {
    const { cx, cy, R } = this.geometry();
    if (len(this.v) < 1e-9) return { x: cx, y: cy };
    const p = toView(normalize(this.v), this.view);
    return { x: cx + p[0] * R, y: cy - p[1] * R };
  }

  private saveView(): void {
    this.ctx.ui.data.views[this.ctx.key] = this.view;
    this.ctx.ui.save();
  }

  private onInput(i: number, val: number, phase: ChangePhase): void {
    if (phase === 'dragStart') {
      this.session.start();
      return;
    }
    const next = [...this.v] as V3;
    next[i] = val;
    this.v = next;
    if (phase === 'commit') this.session.once(this.values(), Math.max(DECIMALS, typedDecimals(val)));
    else if (phase === 'key') this.session.key(this.values(), DECIMALS);
    else if (phase === 'drag') this.session.move(this.values(), DECIMALS);
    else this.session.end(phase === 'dragEnd');
    this.sync();
  }

  private sync(): void {
    this.inputs.forEach((inp, i) => inp.set(Number(this.v[i].toFixed(DECIMALS))));
    const l = len(this.v);
    setText(this.lenText, `|v| = ${formatDisplay(l, 3)}`);
    toggle(this.hint, 'visible', l < 1e-9);
    this.keep.checked = this.keepLength();
    if (this.wCtl) this.wCtl.set(this.w);
    setAttr(this.cv.canvas, 'aria-valuetext', `x ${formatDisplay(this.v[0], 2)}, y ${formatDisplay(this.v[1], 2)}, z ${formatDisplay(this.v[2], 2)}`);
    this.cv.invalidate();
  }

  private draw(c: CanvasRenderingContext2D, w: number, hh: number): void {
    const t = theme();
    const { cx, cy, R } = this.geometry();
    const P = (v: V3) => {
      const p = toView(v, this.view);
      return { x: cx + p[0] * R, y: cy - p[1] * R, z: p[2] };
    };

    c.fillStyle = t.canvasBg;
    c.beginPath();
    c.roundRect(0.5, 0.5, w - 1, hh - 1, 4);
    c.fill();
    c.strokeStyle = withAlpha(t.fg, 0.14);
    c.lineWidth = 1;
    c.stroke();

    // sphere shading
    const g = c.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
    g.addColorStop(0, withAlpha(t.fg, 0.13));
    g.addColorStop(1, withAlpha(t.fg, 0.035));
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = withAlpha(t.fg, 0.22);
    c.stroke();

    // great circles (back halves faint, front halves stronger)
    const circles: [V3, V3][] = [
      [
        [1, 0, 0],
        [0, 0, 1],
      ],
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 1, 0],
        [0, 0, 1],
      ],
    ];
    const N = 96;
    for (const front of [false, true]) {
      c.strokeStyle = withAlpha(t.fg, front ? 0.2 : 0.07);
      c.lineWidth = 1;
      c.beginPath();
      for (const [a, b] of circles) {
        let pen = false;
        for (let i = 0; i <= N; i++) {
          const ang = (i / N) * Math.PI * 2;
          const v: V3 = [a[0] * Math.cos(ang) + b[0] * Math.sin(ang), a[1] * Math.cos(ang) + b[1] * Math.sin(ang), a[2] * Math.cos(ang) + b[2] * Math.sin(ang)];
          const p = P(v);
          if (p.z >= 0 === front) {
            if (pen) c.lineTo(p.x, p.y);
            else c.moveTo(p.x, p.y);
            pen = true;
          } else pen = false;
        }
      }
      c.stroke();
    }

    // axis gizmo
    const names = ['X', 'Y', 'Z'];
    const axes = [0, 1, 2]
      .map((i) => {
        const e: V3 = [0, 0, 0];
        e[i] = 1;
        return { i, p: P(e), n: P(scale(e, -1)) };
      })
      .sort((a, b) => a.p.z - b.p.z);
    c.font = `600 10px ${t.font}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (const a of axes) {
      const col = t.axis[a.i];
      const alpha = a.p.z >= 0 ? 0.95 : 0.35;
      c.strokeStyle = withAlpha(col, 0.18);
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(a.n.x, a.n.y);
      c.stroke();
      c.strokeStyle = withAlpha(col, alpha);
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(a.p.x, a.p.y);
      c.stroke();
      c.lineWidth = 1;
      c.fillStyle = withAlpha(col, alpha);
      const lx = cx + (a.p.x - cx) * 1.16;
      const ly = cy + (a.p.y - cy) * 1.16;
      c.fillText(names[a.i], lx, ly);
    }

    // the vector
    const zero = len(this.v) < 1e-9;
    const u = normalize(this.v);
    const tip = zero ? { x: cx, y: cy, z: 1 } : P(u);
    const back = tip.z < 0;
    const accent = t.accent;
    if (!zero) {
      // ground shadow helps reading depth
      const foot = P([u[0], 0, u[2]]);
      c.setLineDash([2, 3]);
      c.strokeStyle = withAlpha(t.fg, 0.3);
      c.beginPath();
      c.moveTo(tip.x, tip.y);
      c.lineTo(foot.x, foot.y);
      c.lineTo(cx, cy);
      c.stroke();
      c.setLineDash(back ? [4, 3] : []);
      c.strokeStyle = back ? withAlpha(accent, 0.7) : accent;
      c.lineWidth = 2;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(tip.x, tip.y);
      c.stroke();
      c.setLineDash([]);
      c.lineCap = 'butt';
    }
    const big = this.hover || this.session.dragging;
    const r = big ? 6 : 5;
    c.fillStyle = withAlpha(accent, 0.2);
    c.beginPath();
    c.arc(tip.x, tip.y, r + 4, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.arc(tip.x, tip.y, r, 0, Math.PI * 2);
    if (back) {
      c.fillStyle = t.canvasBg;
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = accent;
      c.stroke();
    } else {
      c.fillStyle = accent;
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = t.canvasBg;
      c.stroke();
    }
    c.lineWidth = 1;
    c.beginPath();
    c.arc(cx, cy, 1.5, 0, Math.PI * 2);
    c.fillStyle = withAlpha(t.fg, 0.6);
    c.fill();
  }

  update(ctx: WidgetContext): void {
    this.ctx = ctx;
    this.session.ref = ctx.ref;
    if (this.session.dragging) return;
    const e = expandedValues(ctx.target);
    this.v = [e[0], e[1], e[2]];
    this.w = e[3] ?? 0;
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
