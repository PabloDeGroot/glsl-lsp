// Custom horizontal slider (DOM, not <input type=range> so it can look native
// in every theme): 4px track, fill from the origin, 12px thumb, subtle ticks.
// Press on the track jumps then drags; pressing the thumb grabs it without a
// write; double-clicking the thumb resets (one undo step). Shift = fine;
// keyboard per docs/VALUES.md.

import { clamp, snap } from '../../../shared/valuesMath';
import { formatDisplay } from '../../../shared/valuesMath';
import { fromFraction, modifierFactor, toFraction, type NumRange, type Steps } from '../math/range';
import { h, setAttr, toggle } from './dom';
import { draggable } from './drag';
import type { ChangePhase } from './NumberInput';

export interface SliderOptions {
  name: string;
  range: () => NumRange;
  steps: () => Steps;
  change: (value: number, phase: ChangePhase, decimals: number) => void;
  /** Value restored by double-click (value at selection time). */
  resetValue?: () => number | undefined;
  ticks?: boolean;
  compact?: boolean;
}

export class Slider {
  readonly el: HTMLElement;
  private track: HTMLElement;
  private fill: HTMLElement;
  private thumb: HTMLElement;
  private tickEls: HTMLElement[] = [];
  private value = 0;
  private locked = false;

  constructor(private readonly o: SliderOptions) {
    this.fill = h('div.slider-fill');
    this.thumb = h('div.slider-thumb');
    this.track = h('div.slider-track', null, this.fill);
    const rail = h('div.slider-rail', null, this.track, this.thumb);
    if (o.ticks) {
      const ticks = h('div.slider-ticks', { 'aria-hidden': 'true' });
      for (let i = 0; i < 5; i++) {
        const t = h('span.slider-tick');
        this.tickEls.push(t);
        ticks.append(t);
      }
      rail.prepend(ticks);
    }
    this.el = h(`div.slider${o.compact ? '.compact' : ''}`, { role: 'slider', tabindex: 0, 'aria-label': o.name }, rail);
    this.wire();
  }

  private wire(): void {
    let anchorX = 0;
    let anchorV = 0;
    let fine = false;
    let startV = 0;
    /** Time of the last press that jumped the value (a double-click there is not a reset). */
    let jumpedAt = -Infinity;
    const width = () => Math.max(1, this.track.getBoundingClientRect().width);
    const xOf = (e: PointerEvent) => e.clientX - this.track.getBoundingClientRect().left;

    const compute = (e: PointerEvent): { v: number; decimals: number } => {
      const r = this.o.range();
      const s = this.o.steps();
      const x = xOf(e);
      if (e.shiftKey !== fine) {
        fine = e.shiftKey;
        anchorX = x;
        anchorV = this.value;
      }
      let v: number;
      let step = s.drag;
      let decimals = s.decimals;
      if (fine) {
        v = anchorV + ((x - anchorX) / width()) * (r.max - r.min) * 0.1;
        if (s.decimals > 0) {
          step = s.drag / 10;
          decimals = s.decimals + 1;
        }
      } else v = fromFraction(x / width(), r);
      return { v: clamp(snap(v, step), r.min, r.max), decimals };
    };

    draggable(this.el, {
      start: (e) => {
        if (this.locked || e.button !== 0) return false;
        this.el.focus({ preventScroll: true });
        fine = false;
        startV = this.value;
        this.o.change(this.value, 'dragStart', this.o.steps().decimals);
        const { v, decimals } = compute(e);
        // Pressing on (or right next to) the thumb grabs it without a jump;
        // the second press of a double-click never jumps either.
        if (!this.onThumb(e) && e.detail < 2) {
          jumpedAt = performance.now();
          this.apply(v, 'drag', decimals);
        } else {
          fine = e.shiftKey;
          anchorX = xOf(e);
          anchorV = this.value;
        }
      },
      move: (e) => {
        const { v, decimals } = compute(e);
        this.apply(v, 'drag', decimals);
      },
      end: (_e, cancelled) => {
        if (cancelled) this.setValue(startV);
        this.o.change(this.value, cancelled ? 'dragCancel' : 'dragEnd', this.o.steps().decimals);
      },
    });

    this.el.addEventListener('dblclick', (e) => {
      // Reset only from the thumb, and not right after the first click jumped
      // there (that would write the click position, then the reset: a flash and two undo steps).
      if (!this.onThumb(e) || performance.now() - jumpedAt < 700) return;
      this.reset();
    });

    this.el.addEventListener('keydown', (e) => {
      if (this.locked) return;
      const r = this.o.range();
      const s = this.o.steps();
      let v: number | null = null;
      const f = modifierFactor(e);
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          v = this.value - s.key * f;
          break;
        case 'ArrowRight':
        case 'ArrowUp':
          v = this.value + s.key * f;
          break;
        case 'PageUp':
          v = this.value + s.key * 10;
          break;
        case 'PageDown':
          v = this.value - s.key * 10;
          break;
        case 'Home':
          v = r.min;
          break;
        case 'End':
          v = r.max;
          break;
      }
      if (v === null) return;
      e.preventDefault();
      e.stopPropagation();
      const decimals = e.altKey && s.decimals > 0 ? s.decimals + 1 : s.decimals;
      const step = e.altKey ? s.drag / 10 : s.drag;
      this.apply(clamp(snap(v, step), r.min, r.max), 'key', decimals);
    });
  }

  /** Pointer within the thumb (plus a little slack). */
  private onThumb(e: MouseEvent): boolean {
    if (e.target === this.thumb) return true;
    const r = this.thumb.getBoundingClientRect();
    if (!r.width) return false;
    return Math.abs(e.clientX - (r.left + r.width / 2)) <= r.width / 2 + 3 && Math.abs(e.clientY - (r.top + r.height / 2)) <= r.height / 2 + 6;
  }

  /** Resets to `resetValue` as one edit (no-op when already there). */
  reset(): void {
    const v = this.o.resetValue?.();
    if (v === undefined || !Number.isFinite(v) || this.locked || v === this.value) return;
    this.setValue(v);
    this.o.change(v, 'commit', this.o.steps().decimals);
  }

  private apply(v: number, phase: ChangePhase, decimals: number): void {
    if (v === this.value && phase === 'drag') return;
    this.setValue(v);
    this.o.change(v, phase, decimals);
  }

  /** Re-renders position (call after range changes too). */
  setValue(v: number): void {
    this.value = v;
    const r = this.o.range();
    const f = toFraction(v, r);
    const origin = r.min < 0 && r.max > 0 ? toFraction(0, r) : 0;
    const lo = Math.min(f, origin);
    const hi = Math.max(f, origin);
    this.fill.style.left = `${lo * 100}%`;
    this.fill.style.width = `${(hi - lo) * 100}%`;
    this.thumb.style.left = `${f * 100}%`;
    toggle(this.el, 'out-of-range', Number.isFinite(v) && (v < r.min || v > r.max));
    setAttr(this.el, 'aria-valuemin', r.min);
    setAttr(this.el, 'aria-valuemax', r.max);
    setAttr(this.el, 'aria-valuenow', Number.isFinite(v) ? v : null);
    setAttr(this.el, 'aria-valuetext', Number.isFinite(v) ? formatDisplay(v, this.o.steps().decimals) : 'unknown');
    this.tickEls.forEach((t, i) => (t.style.left = `${(i / (this.tickEls.length - 1)) * 100}%`));
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    toggle(this.el, 'locked', locked);
    setAttr(this.el, 'aria-disabled', locked ? 'true' : null);
    setAttr(this.el, 'tabindex', locked ? -1 : 0);
  }

  focus(): void {
    this.el.focus();
  }
}
