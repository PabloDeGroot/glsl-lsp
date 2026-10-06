// Widget host: header (glyph, name, badges, Color|Vector toggle, go to
// source and, while a pin is selected, a "Pinned" chip with a "Cursor"
// button that always sits at the same place), the widget for the selected
// row (cross-faded on switch, fixed reserved height), empty/stale states, and
// a footer for transient notices.

import type { RowOptions, RowState, TargetRef, ValueTarget, WebviewToExtension } from '../../../shared/valuesProtocol';
import { CURSOR_ROW_ID } from '../../../shared/valuesProtocol';
import type { Bridge } from '../bridge';
import { iconEl, type IconName } from '../icons';
import { glyphSpec, renderGlyph } from '../list/preview';
import { allEditableFloats, chooseWidget, refKey, typeLabel, vecMode, type WidgetKind } from '../math/targets';
import type { UiState } from '../persist';
import type { Store } from '../store';
import { h, iconButton, setAttr, setText, toggle } from '../ui/dom';
import { Segmented } from '../ui/Segmented';
import { ColorPicker } from './ColorPicker';
import { FloatSlider } from './FloatSlider';
import { PaletteEditor } from './PaletteEditor';
import { SliderStack } from './SliderStack';
import { Trackball } from './Trackball';
import { Trackpad } from './Trackpad';
import type { Widget, WidgetContext } from './types';

export interface HostDeps {
  store: Store;
  bridge: Bridge;
  ui: UiState;
  post: (m: WebviewToExtension) => void;
  select: (ref: TargetRef) => void;
}

const FACTORIES: Record<WidgetKind, (ctx: WidgetContext) => Widget> = {
  slider: (c) => new FloatSlider(c),
  trackpad: (c) => new Trackpad(c),
  color: (c) => new ColorPicker(c),
  vector: (c) => new Trackball(c),
  stack: (c) => new SliderStack(c),
  multi: (c) => new SliderStack(c),
  palette: (c) => new PaletteEditor(c),
};

export class WidgetHost {
  readonly el: HTMLElement;
  private headGlyph: HTMLElement;
  private title: HTMLElement;
  private badges: HTMLElement;
  private header: HTMLElement;
  private mode: Segmented<'color' | 'vector'>;
  private gotoBtn: HTMLButtonElement;
  private body: HTMLElement;
  /** "Pinned · ← Cursor" group on the title line, shown while the widget is locked to a pin. */
  private follow: HTMLElement;
  private backBtn: HTMLButtonElement;
  private noticeEl: HTMLElement;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private current: { key: string; widget: Widget | null; el: HTMLElement } | null = null;
  private ctxRef: TargetRef = { rowId: CURSOR_ROW_ID };
  /** Target shown by the current widget (to carry its reset point when its id moves). */
  private lastTarget: ValueTarget | undefined;

  constructor(private readonly d: HostDeps) {
    this.headGlyph = h('span.glyph');
    this.title = h('span.widget-title');
    this.badges = h('div.widget-badges');
    this.mode = new Segmented(
      'Widget mode',
      [
        { value: 'color', label: 'Color', icon: 'color', title: 'Edit as a color' },
        { value: 'vector', label: 'Vector', icon: 'vector', title: 'Edit as a direction' },
      ],
      'color',
      (v) => this.setOptions({ mode: v }),
    );
    this.gotoBtn = iconButton('goto', 'Go to source', { title: 'Go to source (Enter in the list)' });
    this.gotoBtn.addEventListener('click', () => this.d.post({ type: 'reveal', ref: this.ctxRef }));
    this.backBtn = h(
      'button.follow-button',
      { type: 'button', title: 'This editor stays on the pinned value. Click to follow the cursor again (Esc)', 'aria-label': 'Follow the cursor again' },
      iconEl('back'),
      h('span.follow-label', null, 'Cursor'),
    );
    this.backBtn.addEventListener('click', () => this.d.select({ rowId: CURSOR_ROW_ID }));
    this.follow = h('span.follow', null, h('span.pinned-chip', { title: 'Showing a pinned value' }, iconEl('pinned'), h('span.pinned-label', null, 'Pinned')), this.backBtn);
    this.header = h(
      'div.widget-header',
      null,
      // Chips and actions on the title line; the meta line below gets the full
      // width so `file:line` stays readable in a narrow sidebar.
      h('div.widget-title-line', null, this.headGlyph, this.title, h('span.spacer'), this.follow, this.mode.el, this.gotoBtn),
      h('div.widget-sub-line', null, this.badges),
    );
    this.body = h('div.widget-body');
    this.noticeEl = h('span.notice', { role: 'status', 'aria-live': 'polite' });
    this.el = h('section.widget-area', { 'aria-label': 'Value editor' }, this.header, this.body, h('div.widget-footer', null, this.noticeEl));
  }

  private setOptions(options: RowOptions): void {
    const rowId = this.ctxRef.rowId;
    this.d.store.patchOptions(rowId, options);
    // undefined fields do not survive serialisation: send them as explicit resets.
    const clear = (Object.keys(options) as (keyof RowOptions)[]).filter((k) => options[k] === undefined);
    this.d.post({ type: 'setRowOptions', rowId, options, ...(clear.length ? { clear } : {}) });
  }

  notice(text: string, severity: 'info' | 'warning' = 'info'): void {
    setText(this.noticeEl, text);
    toggle(this.noticeEl, 'warn', severity === 'warning');
    this.noticeEl.classList.remove('visible');
    void this.noticeEl.offsetWidth;
    this.noticeEl.classList.add('visible');
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.noticeEl.classList.remove('visible'), 3200);
  }

  render(): void {
    const { ref, row, target } = this.d.store.selected;
    this.ctxRef = ref;
    const onPin = ref.rowId !== CURSOR_ROW_ID;
    toggle(this.follow, 'hidden', !onPin);
    toggle(this.el, 'on-pin', onPin);

    // Loading keeps the previous widget in place (no flash).
    if (row?.status === 'loading' && this.current?.widget) return;
    if (!row || row.status !== 'ok' || !target) {
      this.renderHeader(row, undefined, ref);
      this.swap(`empty:${row?.id ?? 'none'}:${row?.status ?? 'none'}`, () => ({ widget: null, el: this.emptyState(row) }));
      return;
    }
    const parent = row.target!;
    const options = row.options ?? {};
    // Children share the row's options (a multi/palette parent has no mode/range of its own).
    const optionsFor = options;
    const kind = chooseWidget(target, optionsFor);
    const identity = row.kind === 'cursor' ? `${parent.uri}:${parent.id}` : row.id;
    const key = `${refKey(ref)}|${identity}|${kind}`;
    this.renderHeader(row, target, ref);
    const resets = this.d.store.resets;
    if (this.current?.key === key && this.lastTarget) resets.follow(this.lastTarget, target);
    this.lastTarget = target;
    resets.capture(target);
    const ctx: WidgetContext = {
      ref,
      row,
      target,
      options: optionsFor,
      settings: this.d.store.settings,
      bridge: this.d.bridge,
      ui: this.d.ui,
      key: `${refKey(ref)}|${identity}`,
      resetPoint: (t) => resets.capture(t),
      setOptions: (o) => this.setOptions(o),
      select: (r) => this.d.select(r),
      notice: (t, s) => this.notice(t, s),
    };
    if (this.current?.key === key && this.current.widget) {
      this.current.widget.update(ctx);
      return;
    }
    this.swap(key, () => {
      const widget = FACTORIES[kind](ctx);
      return { widget, el: widget.el };
    });
  }

  private renderHeader(row: RowState | undefined, target: ValueTarget | undefined, ref: TargetRef): void {
    const ok = !!target && row?.status === 'ok';
    toggle(this.header, 'empty', !ok && row?.status !== 'stale');
    renderGlyph(this.headGlyph, glyphSpec(row, target, row?.options));
    let title = row?.label ?? '';
    if (ok && ref.childIndex !== undefined && row?.target) {
      title = target!.name ?? `#${ref.childIndex + 1}`;
    }
    setText(this.title, row?.status === 'stale' ? row.label : ok ? title : '');
    setAttr(this.title, 'title', target?.snippet ?? null);

    // badges
    const badges: string[] = [];
    let loc = '';
    if (ok && target) {
      badges.push(typeLabel(target));
      if ((target.kind === 'vec3' || target.kind === 'vec4') && allEditableFloats(target)) {
        const color = vecMode(target, row?.options) === 'color';
        badges.push(color ? 'color' : 'direction');
        if (color && target.components.some((c) => c.value > 1)) badges.push('HDR');
      }
      // (a uniform's `in { min, max }` is shown by the range fields of the widget itself)
      if (target.uniform) badges.push('#iUniform');
      else if (target.declKind === 'const' || target.declKind === 'define') badges.push(target.declKind === 'define' ? '#define' : 'const');
      if (ref.childIndex !== undefined && row) badges.push(`in ${row.label}`);
      else if (target.functionName) badges.push(`${target.functionName}()`);
    }
    if (row && row.fileName && row.status !== 'noEditor' && (row.status === 'ok' || row.status === 'stale')) loc = `${row.fileName}${row.line ? `:${row.line}` : ''}`;
    const sig = `${badges.join('|')}@${loc}`;
    if (this.badges.dataset.sig !== sig) {
      this.badges.dataset.sig = sig;
      // Descriptive chips give way first; the location truncates last.
      this.badges.replaceChildren(
        ...badges.map((b, i) => h(`span.badge-chip${i === 0 ? '.lead' : ''}`, { title: b }, b)),
        ...(loc ? [h('span.badge-chip.loc', { title: loc }, loc)] : []),
      );
    }

    const showMode = ok && !!target && (target.kind === 'vec3' || target.kind === 'vec4') && allEditableFloats(target);
    toggle(this.mode.el, 'hidden', !showMode);
    if (showMode) this.mode.set(vecMode(target!, row?.options));
    toggle(this.gotoBtn, 'hidden', !ok && row?.status !== 'stale');
  }

  private swap(key: string, make: () => { widget: Widget | null; el: HTMLElement }): void {
    if (this.current?.key === key) return;
    const old = this.current;
    const hadFocus = !!old && old.el.contains(document.activeElement);
    const next = make();
    next.el.classList.add('widget-pane');
    this.current = { key, ...next };
    if (old) {
      old.widget?.dispose();
      old.el.classList.add('leaving');
      old.el.setAttribute('aria-hidden', 'true');
      old.el.inert = true;
      setTimeout(() => old.el.remove(), 140);
    }
    if (old) next.el.classList.add('entering');
    this.body.append(next.el);
    if (hadFocus) next.widget?.focus();
  }

  private emptyState(row: RowState | undefined): HTMLElement {
    const box = (icon: IconName, title: string, help: string | null, ...extra: HTMLElement[]) =>
      h('div.empty-state', null, iconEl(icon, `empty-icon${icon === 'warning' ? ' tone-warn' : ''}`), h('div.empty-title', null, title), help ? h('div.empty-help', null, help) : null, ...extra);
    if (!row || row.status === 'noEditor') return box('file', 'No GLSL file', 'Open a GLSL file and put the cursor on a number, vec2/vec3/vec4 or color.');
    if (row.status === 'empty') {
      const tip = h('div.empty-tip', null, 'Tip: ', h('kbd', null, 'Ctrl'), '+', h('kbd', null, 'Alt'), '+', h('kbd', null, '↑'), '/', h('kbd', null, '↓'), ' nudges the number under the cursor.');
      return box('target', 'No value at the cursor', 'Put the cursor on a number, a vec2/vec3/vec4 constructor, a color or a uniform.', tip);
    }
    if (row.status === 'loading') return box('target', 'Looking for values…', null);
    if (row.status === 'stale') {
      const go = h('button.button.secondary.small', { type: 'button' }, iconEl('goto'), h('span', null, 'Go to last location'));
      go.addEventListener('click', () => this.d.post({ type: 'reveal', ref: { rowId: row.id } }));
      const unpin = h('button.button.secondary.small', { type: 'button' }, iconEl('close'), h('span', null, 'Unpin'));
      unpin.addEventListener('click', () => {
        this.d.post({ type: 'unpin', pinId: row.id });
        this.d.select({ rowId: CURSOR_ROW_ID });
      });
      return box('warning', 'Value not found', `This value is no longer in ${row.fileName ?? 'its file'}.`, h('div.empty-actions', null, go, unpin));
    }
    return box('target', 'Nothing selected', null);
  }

  /** Focuses the widget; false when there is none (empty state). */
  focus(): boolean {
    if (!this.current?.widget) return false;
    this.current.widget.focus();
    return true;
  }

  /** A gesture was rejected: re-render from state (the widget drops its drag). */
  refresh(): void {
    if (this.current) this.current.key = '';
    this.render();
  }
}
