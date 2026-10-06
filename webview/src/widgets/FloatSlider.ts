// float -> slider + numeric input + editable range. `FloatControl` is the
// reusable slider/input pair (slider stacks, vec4 W, HDR intensity).

import type { RowOptions, UniformInfo } from '../../../shared/valuesProtocol';
import { formatDisplay } from '../../../shared/valuesMath';
import type { EditSession, Values } from '../bridge';
import { iconEl } from '../icons';
import { differsFrom } from '../math/resetPoints';
import { displayDecimals, extendRange, floatRange, shownDecimals, stepsFor, typedDecimals, type NumRange, type RangeSource, type Steps } from '../math/range';
import { h, iconButton, setAttr, setText, toggle } from '../ui/dom';
import { NumberInput, type ChangePhase } from '../ui/NumberInput';
import { Slider } from '../ui/Slider';
import type { Widget, WidgetContext } from './types';
import { EditSession as Session } from '../bridge';

/** Decimals a typed value needs (exponent aware, see math/range). */
export { typedDecimals } from '../math/range';

/**
 * Explains where a slider range comes from, next to its min/max fields:
 * `#iUniform` bounds are read-only (dashed fields, lock, "from #iUniform"),
 * the automatic range and a custom range are editable (solid fields).
 */
export function showRangeSource(caption: HTMLElement, fields: NumberInput[], src: RangeSource, autoExtra = ''): void {
  const ro = src === 'uniform';
  for (const inp of fields) {
    inp.input.readOnly = ro;
    toggle(inp.el, 'readonly', ro);
    const which = inp === fields[0] ? 'minimum' : 'maximum';
    setAttr(
      inp.input,
      'title',
      ro
        ? `Slider ${which} from the #iUniform declaration (read-only here, edit it in the source)`
        : src === 'user'
          ? `Custom slider ${which}`
          : `Automatic slider ${which} (type a value to set your own range)`,
    );
  }
  const text = ro ? 'from #iUniform' : src === 'user' ? 'custom range' : `auto range${autoExtra}`;
  const sig = `${src}|${text}`;
  if (caption.dataset.sig === sig) return;
  caption.dataset.sig = sig;
  caption.dataset.src = src;
  caption.replaceChildren(...(ro ? [iconEl('lock', 'range-src-icon')] : []), h('span.range-src-text', null, text));
  setAttr(
    caption,
    'title',
    ro
      ? 'The range is set by the #iUniform declaration (dashed, read-only fields)'
      : src === 'user'
        ? 'A range you set (reset to go back to the automatic one)'
        : 'Picked around the value; type a bound to set your own range',
  );
}

export interface FloatControlOptions {
  name: string;
  /** Short label left of the slider (stack rows). */
  label?: string;
  axis?: 'x' | 'y' | 'z' | 'w';
  session: EditSession;
  /** Current full values (EditUpdate layout) to patch `index` into. */
  values: () => Values;
  index: number;
  integer?: boolean;
  uniform?: UniformInfo;
  /** Row range override (persisted with setRowOptions), or null when not supported. */
  userRange?: () => NumRange | undefined;
  setUserRange?: (r: NumRange | undefined) => void;
  /** Explicit range (bypasses uniform/user/auto), e.g. HDR intensity. */
  fixedRange?: () => NumRange;
  showRange?: boolean;
  compact?: boolean;
  ticks?: boolean;
  resetValue?: () => number | undefined;
  /** Display decimals of the numeric field (the literal's own precision). */
  displayDecimals?: () => number;
  /** Hook replacing the edit routing (HDR intensity rewrites three components). */
  onChange?: (v: number, phase: ChangePhase, decimals: number) => void;
}

export class FloatControl {
  readonly el: HTMLElement;
  readonly slider: Slider;
  readonly input: NumberInput;
  private auto: NumRange | null = null;
  private value = NaN;
  private rangeLine: HTMLElement | null = null;
  private minInput: NumberInput | null = null;
  private maxInput: NumberInput | null = null;
  private caption: HTMLElement | null = null;
  private resetRange: HTMLButtonElement | null = null;

  constructor(private readonly o: FloatControlOptions) {
    this.slider = new Slider({
      name: o.name,
      range: () => this.range(),
      steps: () => this.steps(),
      change: (v, phase, d) => this.change(v, phase, d),
      resetValue: o.resetValue,
      ticks: o.ticks,
      compact: o.compact,
    });
    this.input = new NumberInput({
      name: o.name,
      step: () => this.steps().drag,
      decimals: () => this.steps().decimals,
      displayDecimals: o.displayDecimals,
      change: (v, phase) => this.change(v, phase, phase === 'commit' ? typedDecimals(v) : this.steps().decimals),
      size: 'md',
    });
    const main = h('div.float-main', null, this.slider.el, this.input.el);
    if (o.label) {
      const lab = h(`span.stack-label${o.axis ? `.axis-${o.axis}` : ''}`, { title: o.name }, o.label);
      main.prepend(lab);
    }
    this.el = h(`div.float-control${o.compact ? '.compact' : ''}`, null, main);
    if (o.showRange) this.buildRangeLine();
  }

  private buildRangeLine(): void {
    const mk = (which: 'min' | 'max') =>
      new NumberInput({
        name: `Range ${which}`,
        title: `Slider ${which}imum`,
        size: 'sm',
        step: () => this.steps().key,
        decimals: () => Math.max(1, this.steps().decimals - 1),
        // `0`, `0.1`, `2`: a bound shows only the digits it has.
        displayDecimals: () => 0,
        change: (v, phase) => {
          if (phase !== 'commit' && phase !== 'key') return;
          const r = this.range();
          const next = which === 'min' ? { min: v, max: r.max } : { min: r.min, max: v };
          if (!(next.max > next.min)) {
            this.syncRange();
            return;
          }
          this.o.setUserRange?.(next);
          this.slider.setValue(this.value);
        },
      });
    this.minInput = mk('min');
    this.maxInput = mk('max');
    this.caption = h('span.range-caption');
    this.resetRange = iconButton('reset', 'Reset range', { title: 'Back to the automatic range', cls: 'tiny' });
    this.resetRange.addEventListener('click', () => {
      this.auto = null;
      this.o.setUserRange?.(undefined);
      this.syncRange();
    });
    this.rangeLine = h('div.range-line', null, this.minInput.el, h('span.range-mid', null, this.caption, this.resetRange), this.maxInput.el);
    this.el.append(this.rangeLine);
  }

  private source(): RangeSource {
    if (this.o.fixedRange) return 'auto';
    return floatRange(this.value, this.o.uniform, { range: this.o.userRange?.() }).source;
  }

  range(): NumRange {
    if (this.o.fixedRange) return this.o.fixedRange();
    const r = floatRange(this.value, this.o.uniform, { range: this.o.userRange?.() });
    if (r.source !== 'auto') return r;
    // Freeze the automatic range so it does not jump while dragging; extend when the value leaves it.
    if (!this.auto) this.auto = { min: r.min, max: r.max };
    else if (Number.isFinite(this.value)) this.auto = extendRange(this.auto, this.value);
    return this.auto;
  }

  steps(): Steps {
    return stepsFor(this.range(), { uniformStep: this.o.uniform?.step, integer: this.o.integer });
  }

  private change(v: number, phase: ChangePhase, decimals: number): void {
    if (this.o.onChange) {
      this.value = v;
      this.input.set(v);
      if (phase === 'key' || phase === 'commit') this.slider.setValue(v);
      this.o.onChange(v, phase, decimals);
      return;
    }
    const s = this.o.session;
    const vals = () => {
      const a = this.o.values().slice();
      a[this.o.index] = this.o.integer ? Math.round(v) : v;
      return a;
    };
    this.value = v;
    switch (phase) {
      case 'dragStart':
        s.start();
        break;
      case 'drag':
        this.input.set(v);
        s.move(vals(), decimals);
        break;
      case 'dragEnd':
        s.end(true);
        break;
      case 'dragCancel':
        s.end(false);
        break;
      case 'key':
        this.input.set(v);
        this.slider.setValue(v);
        s.key(vals(), decimals);
        break;
      case 'commit': {
        // Typing outside the range grows a user range (never a uniform range).
        const r = this.range();
        if ((v < r.min || v > r.max) && this.source() !== 'uniform' && this.o.setUserRange) this.o.setUserRange(extendRange(r, v));
        this.slider.setValue(v);
        s.once(vals(), decimals);
        break;
      }
    }
    this.syncRange();
  }

  /** New value from state. */
  set(v: number, locked = false, lockedText?: string): void {
    this.value = v;
    this.slider.setLocked(locked);
    if (locked) this.input.setLocked(lockedText ?? '?');
    else this.input.set(v);
    this.slider.setValue(v);
    this.syncRange();
  }

  private syncRange(): void {
    if (!this.rangeLine) return;
    const r = this.range();
    const src = this.source();
    const d = Math.max(1, Math.min(4, this.steps().decimals - 1));
    this.minInput!.set(Number(r.min.toFixed(d)));
    this.maxInput!.set(Number(r.max.toFixed(d)));
    showRangeSource(this.caption!, [this.minInput!, this.maxInput!], src);
    toggle(this.resetRange!, 'hidden', src !== 'user');
  }

  focus(): void {
    this.slider.focus();
  }
}

/** The float widget. */
export class FloatSlider implements Widget {
  readonly el: HTMLElement;
  private ctl: FloatControl;
  private session: Session;
  private ctx: WidgetContext;
  private resetBtn: HTMLButtonElement;
  private resetText: HTMLElement;
  private resetSig = '';

  constructor(ctx: WidgetContext) {
    this.ctx = ctx;
    this.session = new Session(ctx.bridge, ctx.ref);
    const c = ctx.target.components[0];
    this.ctl = new FloatControl({
      name: ctx.target.name ?? 'value',
      session: this.session,
      values: () => [this.ctx.target.components[0].value],
      index: 0,
      integer: c.integer,
      uniform: ctx.target.uniform,
      userRange: () => this.ctx.options.range,
      setUserRange: (r) => this.ctx.setOptions({ range: r }),
      showRange: true,
      ticks: true,
      resetValue: () => this.resetValue(),
      displayDecimals: () => displayDecimals(this.ctx.target.components[0]?.text, c.integer),
    });
    this.resetText = h('span');
    this.resetBtn = h('button.link-button.reset-link', { type: 'button' }, iconEl('reset'), this.resetText);
    this.resetBtn.addEventListener('click', () => this.ctl.slider.reset());
    const hint = h('div.widget-hint', null, this.resetBtn, h('span.hint-extra', null, 'Shift for fine steps'));
    this.el = h('div.w-float', null, this.ctl.el, hint);
    this.update(ctx);
  }

  update(ctx: WidgetContext): void {
    this.ctx = ctx;
    this.session.ref = ctx.ref;
    this.syncReset(ctx.target.components[0].value);
    if (this.session.dragging) return;
    this.ctl.set(ctx.target.components[0].value);
  }

  /** The value at this target's first selection / gesture (not this widget's construction). */
  private resetValue(): number | undefined {
    return this.ctx.resetPoint(this.ctx.target)[0];
  }

  /** "Reset to X" only once the value differs from X (kept in the layout, so nothing jumps). */
  private syncReset(v: number): void {
    const r = this.resetValue();
    const c = this.ctx.target.components[0];
    const show = differsFrom(v, r) && !!c?.editable;
    const text = r === undefined ? '' : formatDisplay(r, shownDecimals(r, displayDecimals(c?.text, c?.integer)));
    const sig = `${show}|${text}`;
    if (sig === this.resetSig) return;
    this.resetSig = sig;
    setText(this.resetText, `Reset to ${text}`);
    setAttr(this.resetBtn, 'title', show ? `Reset to ${text} (or double-click the thumb)` : null);
    toggle(this.resetBtn, 'invisible', !show);
    this.resetBtn.disabled = !show;
    setAttr(this.resetBtn, 'aria-hidden', show ? null : 'true');
  }

  focus(): void {
    this.ctl.focus();
  }

  dispose(): void {
    this.session.end(true);
  }
}

export type { RowOptions };
