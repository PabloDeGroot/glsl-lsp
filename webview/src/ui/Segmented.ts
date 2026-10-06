// Segmented toggle ([Color | Vector]) styled like VS Code input options.

import type { IconName } from '../icons';
import { iconEl } from '../icons';
import { h, setAttr, toggle } from './dom';

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  title?: string;
}

export class Segmented<T extends string> {
  readonly el: HTMLElement;
  private buttons: HTMLButtonElement[] = [];
  private value: T;

  constructor(
    name: string,
    private readonly segments: Segment<T>[],
    initial: T,
    private readonly onChange: (v: T) => void,
  ) {
    this.value = initial;
    this.el = h('div.segmented', { role: 'radiogroup', 'aria-label': name });
    for (const s of segments) {
      const b = h('button.segment', { type: 'button', role: 'radio', title: s.title ?? s.label });
      if (s.icon) b.append(iconEl(s.icon));
      b.append(h('span.segment-label', null, s.label));
      b.addEventListener('click', () => this.pick(s.value));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const i = this.segments.findIndex((x) => x.value === this.value);
        const n = this.segments[(i + (e.key === 'ArrowRight' ? 1 : this.segments.length - 1)) % this.segments.length];
        this.pick(n.value);
        this.buttons[this.segments.indexOf(n)].focus();
      });
      this.buttons.push(b);
      this.el.append(b);
    }
    this.render();
  }

  private pick(v: T): void {
    if (v === this.value) return;
    this.value = v;
    this.render();
    this.onChange(v);
  }

  set(v: T): void {
    this.value = v;
    this.render();
  }

  private render(): void {
    this.segments.forEach((s, i) => {
      const on = s.value === this.value;
      toggle(this.buttons[i], 'active', on);
      setAttr(this.buttons[i], 'aria-checked', on ? 'true' : 'false');
      setAttr(this.buttons[i], 'tabindex', on ? 0 : -1);
    });
  }
}
