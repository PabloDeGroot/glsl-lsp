// Tiny DOM helpers (no framework). Never sets `style` attributes (CSP):
// dynamic styles go through element.style (CSSOM) only.

import { iconEl, type IconName } from '../icons';

type Attrs = Record<string, string | number | boolean | undefined>;

/** Creates an element: `h('div.row.selected', {role: 'option'}, child, 'text')`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}`,
  attrs?: Attrs | null,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag as K);
  if (classes.length) el.className = classes.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (k === 'style') throw new Error('inline style attributes are blocked by the CSP');
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Sets textContent only when it changed (avoids layout work and selection loss). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setAttr(el: Element, name: string, value: string | number | null | undefined): void {
  if (value === null || value === undefined) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  const s = String(value);
  if (el.getAttribute(name) !== s) el.setAttribute(name, s);
}

export function toggle(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

/** A 16px icon button with tooltip and accessible label. */
export function iconButton(icon: IconName, label: string, opts: { title?: string; cls?: string; tabbable?: boolean } = {}): HTMLButtonElement {
  const b = h('button.icon-button', {
    type: 'button',
    'aria-label': label,
    title: opts.title ?? label,
    tabindex: opts.tabbable === false ? -1 : undefined,
  });
  if (opts.cls) b.classList.add(...opts.cls.split(' '));
  b.append(iconEl(icon));
  return b;
}

/** Replaces a button's icon. */
export function setIcon(b: HTMLElement, icon: IconName): void {
  if (b.dataset.icon === icon) return;
  b.dataset.icon = icon;
  b.replaceChildren(iconEl(icon));
}

let uid = 0;
export const nextId = (prefix: string): string => `${prefix}-${++uid}`;
