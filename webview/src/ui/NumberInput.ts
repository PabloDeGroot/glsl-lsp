// Compact numeric field: optional axis-colored label that scrubs on drag,
// select-all on focus, commit on Enter/blur, Escape reverts, arrow keys step.
// A focused field is never overwritten by incoming state.

import { decimalsForStep, formatDisplay } from '../../../shared/valuesMath';
import { modifierFactor, parseNumber, shownDecimals } from '../math/range';
import { h, setAttr, setText, toggle } from './dom';
import { draggable } from './drag';

export type Axis = 'x' | 'y' | 'z' | 'w';

export type ChangePhase = 'commit' | 'key' | 'dragStart' | 'drag' | 'dragEnd' | 'dragCancel';

export interface NumberInputOptions {
  label?: string;
  axis?: Axis;
  /** Accessible name (defaults to label). */
  name?: string;
  title?: string;
  /** Step per arrow key / per scrub pixel. */
  step: () => number;
  /** Precision of keyboard / scrub steps (values are rounded to it). */
  decimals: () => number;
  /**
   * Display decimals (the literal's own precision); more are shown only when
   * the value needs them. Defaults to `decimals`.
   */
  displayDecimals?: () => number;
  change: (value: number, phase: ChangePhase) => void;
  /** Extra class names for the wrapper. */
  cls?: string;
  /** Wider/narrower field. */
  size?: 'sm' | 'md';
  /** Horizontal drag on the field itself scrubs (a click without motion focuses it). */
  scrubField?: boolean;
}

export class NumberInput {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private label: HTMLElement | null = null;
  private value = NaN;
  private locked = false;

  constructor(private readonly o: NumberInputOptions) {
    this.input = h('input.num-input', {
      type: 'text',
      inputmode: 'decimal',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': o.name ?? o.label ?? 'value',
      title: o.title,
    });
    this.el = h(`div.num-field${o.axis ? `.axis-${o.axis}` : ''}${o.size ? `.${o.size}` : ''}`);
    if (o.cls) this.el.classList.add(...o.cls.split(' '));
    if (o.label) {
      this.label = h('span.num-label', { 'aria-hidden': 'true', title: `Drag to change ${o.name ?? o.label}` }, o.label);
      this.el.append(this.label);
      this.wireScrub(this.label);
    }
    this.el.append(this.input);
    if (o.scrubField) {
      this.el.classList.add('scrub-field');
      // Until focused, the field behaves like a scrub handle; a plain click focuses it.
      this.input.addEventListener(
        'pointerdown',
        (e) => {
          if (document.activeElement !== this.input) e.preventDefault();
        },
        true,
      );
      this.wireScrub(this.input, () => {
        this.input.focus();
      });
    }

    this.input.addEventListener('focus', () => {
      this.el.classList.add('focused');
      requestAnimationFrame(() => this.input.select());
    });
    this.input.addEventListener('blur', () => {
      this.el.classList.remove('focused');
      this.commitTyped();
      this.render();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
  }

  private onKey(e: KeyboardEvent): void {
    if (this.locked) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitTyped();
      this.render();
      this.input.select();
    } else if (e.key === 'Escape') {
      const changed = this.input.value !== this.text();
      if (changed) {
        e.preventDefault();
        e.stopPropagation();
        this.render(true);
        this.input.select();
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const typed = parseNumber(this.input.value);
      const base = typed ?? this.value;
      if (!Number.isFinite(base)) return;
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const step = this.o.step() * modifierFactor(e);
      const v = round(base + dir * step, Math.max(this.o.decimals(), decimalsForStep(step)));
      this.value = v;
      this.render(true);
      this.input.select();
      this.o.change(v, 'key');
    }
  }

  private commitTyped(): void {
    if (this.locked) return;
    const raw = this.input.value;
    if (raw === this.text()) return;
    const v = parseNumber(raw);
    if (v === null) {
      this.el.classList.add('invalid');
      setTimeout(() => this.el.classList.remove('invalid'), 400);
      return;
    }
    this.value = v;
    this.o.change(v, 'commit');
  }

  private wireScrub(handle: HTMLElement, click?: () => void): void {
    let start = 0;
    let acc = 0;
    draggable(handle, {
      threshold: 3,
      click,
      start: () => {
        if (document.activeElement === this.input && handle === this.input) return false;
        if (this.locked || !Number.isFinite(this.value)) return false;
        start = this.value;
        acc = 0;
        this.o.change(start, 'dragStart');
      },
      move: (e) => {
        acc += e.movementX * modifierFactor(e);
        const v = round(start + acc * this.o.step(), this.o.decimals());
        if (v === this.value) return;
        this.value = v;
        this.render(true);
        this.o.change(v, 'drag');
      },
      end: (_e, cancelled) => {
        if (cancelled) {
          this.value = start;
          this.render(true);
        }
        this.o.change(this.value, cancelled ? 'dragCancel' : 'dragEnd');
      },
    });
  }

  private text(): string {
    if (!Number.isFinite(this.value)) return '';
    if (!this.o.displayDecimals) return formatDisplay(this.value, this.o.decimals());
    return formatDisplay(this.value, shownDecimals(this.value, this.o.displayDecimals()));
  }

  private render(force = false): void {
    if (this.locked) return;
    if (!force && document.activeElement === this.input) return;
    const t = this.text();
    if (this.input.value !== t) this.input.value = t;
  }

  /** Updates the shown value (ignored while the field has focus). */
  set(value: number): void {
    if (this.locked) this.setLocked(null);
    if (document.activeElement === this.input) return;
    this.value = value;
    this.render();
  }

  /** Shows a non-editable expression (locked component); null unlocks. */
  setLocked(text: string | null): void {
    this.locked = text !== null;
    toggle(this.el, 'locked', this.locked);
    this.input.readOnly = this.locked;
    setAttr(this.input, 'aria-readonly', this.locked ? 'true' : null);
    if (text !== null) {
      this.input.value = text;
      setAttr(this.input, 'title', `${text} is not a literal (locked)`);
    } else setAttr(this.input, 'title', this.o.title ?? null);
    if (this.label) setText(this.label, this.o.label ?? '');
  }

  get current(): number {
    return this.value;
  }

  focus(): void {
    this.input.focus();
  }
}

function round(v: number, decimals: number): number {
  const d = Math.max(0, Math.min(6, decimals));
  return Number(v.toFixed(d));
}
