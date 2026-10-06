// The VALUES list: CURSOR section (always-first cursor row with a pin
// button) and PINNED section (pins with unpin). Rows are patched in place
// (keyed), so focus, scrubbing and hover survive state pushes.

import type { RowState, TargetRef, ValueTarget, WebviewToExtension } from '../../../shared/valuesProtocol';
import { CURSOR_ROW_ID } from '../../../shared/valuesProtocol';
import type { Bridge, Gesture } from '../bridge';
import { iconEl } from '../icons';
import { displayDecimals, parseNumber, scrubDecimals, scrubStep, shownDecimals, typedDecimals } from '../math/range';
import { formatDisplay } from '../../../shared/valuesMath';
import { childLabel, expandedValues, refKey, sameRef } from '../math/targets';
import type { UiState } from '../persist';
import type { Store } from '../store';
import { h, iconButton, setAttr, setIcon, setText, toggle } from '../ui/dom';
import { draggable } from '../ui/drag';
import { glyphSpec, previewSpec, renderGlyph, type PreviewSpec } from './preview';

export interface ListDeps {
  store: Store;
  bridge: Bridge;
  ui: UiState;
  post: (m: WebviewToExtension) => void;
  select: (ref: TargetRef) => void;
  /** Escape with a pin selected. */
  backToCursor: () => void;
}

type Action = 'pin' | 'unpin' | 'unpinCursor' | 'pinChild';

interface ActionModel {
  action: Action;
  icon: 'pin' | 'pinned' | 'close';
  label: string;
  title: string;
  always?: boolean;
}

interface LineModel {
  domId: string;
  ref: TargetRef;
  row: RowState;
  target: ValueTarget | undefined;
  depth: 0 | 1;
  twistie: 'none' | 'open' | 'closed';
  label: string;
  labelTone?: 'muted' | 'stale';
  title: string;
  badge?: string;
  preview: PreviewSpec;
  action?: ActionModel;
  selected: boolean;
}

/** Full component values (EditUpdate layout) of a vector/float target; locked -> null. */
export function fullValues(t: ValueTarget): (number | null)[] {
  return expandedValues(t).map((v) => (Number.isFinite(v) ? v : null));
}

class Line {
  readonly el: HTMLElement;
  private twistie: HTMLElement;
  private glyph: HTMLElement;
  private label: HTMLElement;
  private badge: HTMLElement;
  private badgeText: HTMLElement;
  private preview: HTMLElement;
  private actionBtn: HTMLButtonElement | null = null;
  model!: LineModel;
  /** Number span being scrubbed (do not re-render its text from state). */
  scrubbing = false;
  editing = false;

  constructor(
    private readonly list: List,
    domId: string,
  ) {
    this.twistie = h('span.twistie', { 'aria-hidden': 'true' });
    this.glyph = h('span.glyph');
    this.label = h('span.label');
    this.badgeText = h('span.badge-text');
    this.badge = h('span.badge', null, iconEl('file', 'badge-icon'), this.badgeText);
    this.preview = h('span.preview');
    this.el = h('div.line', { id: domId, role: 'option' }, this.twistie, this.glyph, this.label, this.badge, this.preview);
  }

  update(m: LineModel): void {
    const prev = this.model;
    this.model = m;
    toggle(this.el, 'child', m.depth === 1);
    toggle(this.el, 'cursor-row', m.row.kind === 'cursor' && m.depth === 0);
    toggle(this.el, 'selected', m.selected);
    toggle(this.el, 'stale', m.row.status === 'stale');
    setAttr(this.el, 'aria-selected', m.selected ? 'true' : 'false');
    setAttr(this.el, 'title', m.title || null);
    setAttr(this.el, 'aria-level', m.depth + 1);
    setAttr(this.el, 'aria-expanded', m.twistie === 'none' ? null : m.twistie === 'open' ? 'true' : 'false');

    // twistie
    if (m.twistie === 'none') {
      if (this.twistie.firstChild) this.twistie.replaceChildren();
    } else if (!this.twistie.firstChild) this.twistie.append(iconEl('chevron'));
    toggle(this.twistie, 'open', m.twistie === 'open');
    toggle(this.twistie, 'collapsible', m.twistie !== 'none');

    renderGlyph(this.glyph, glyphSpec(m.row, m.target, m.row.options));
    setText(this.label, m.label);
    this.label.className = `label${m.labelTone ? ` tone-${m.labelTone}` : ''}`;
    setText(this.badgeText, m.badge ?? '');
    setAttr(this.badge, 'title', m.badge ? `In ${m.badge}` : null);
    toggle(this.badge, 'hidden', !m.badge);

    if (!this.scrubbing && !this.editing) this.renderPreview(m.preview, prev?.preview);

    // action
    if (m.action) {
      if (!this.actionBtn) {
        this.actionBtn = iconButton(m.action.icon, m.action.label, { tabbable: false, cls: 'row-action' });
        this.el.append(this.actionBtn);
      }
      setIcon(this.actionBtn, m.action.icon);
      this.actionBtn.dataset.action = m.action.action;
      setAttr(this.actionBtn, 'aria-label', m.action.label);
      setAttr(this.actionBtn, 'title', m.action.title);
      toggle(this.actionBtn, 'always', !!m.action.always);
      toggle(this.actionBtn, 'on', m.action.icon === 'pinned');
    } else if (this.actionBtn) {
      this.actionBtn.remove();
      this.actionBtn = null;
    }
    toggle(this.el, 'has-action', !!m.action);
  }

  private renderPreview(p: PreviewSpec, prev: PreviewSpec | undefined): void {
    const el = this.preview;
    const sig = p.kind === 'nums' ? `nums:${p.nums.length}:${p.nums.map((n) => (n.locked ? 'l' : 'e')).join('')}` : p.kind;
    const prevSig = prev ? (prev.kind === 'nums' ? `nums:${prev.nums.length}:${prev.nums.map((n) => (n.locked ? 'l' : 'e')).join('')}` : prev.kind) : '';
    if (sig !== prevSig || el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.replaceChildren();
      el.className = `preview preview-${p.kind}`;
      if (p.kind === 'nums') {
        p.nums.forEach((n) => {
          const s = h(`span.num${n.locked ? '.locked' : ''}`);
          if (!n.locked) {
            s.dataset.comp = String(n.comp);
            this.list.wireScrub(this, s);
          }
          el.append(s);
        });
      } else if (p.kind === 'text') el.append(h('span.preview-text'));
      else if (p.kind === 'strip') el.append(h('span.preview-strip'));
      else if (p.kind === 'loading') el.append(h('span.skeleton'));
    }
    if (p.kind === 'nums') {
      p.nums.forEach((n, i) => {
        const s = el.children[i] as HTMLElement;
        setText(s, n.text);
        setAttr(s, 'title', n.locked ? `${n.text} (not a literal)` : 'Drag to change · double-click to type');
      });
    } else if (p.kind === 'text') {
      const s = el.firstElementChild as HTMLElement;
      setText(s, p.text);
      s.className = `preview-text${p.tone ? ` tone-${p.tone}` : ''}`;
    } else if (p.kind === 'strip') (el.firstElementChild as HTMLElement).style.background = p.gradient;
  }

  get previewEl(): HTMLElement {
    return this.preview;
  }

  /**
   * The label truncates first; once it is down to a few characters the file
   * badge collapses to its icon (full name in the tooltip) instead of both
   * ending as unreadable fragments (`u_extremelyL… p…`).
   */
  fitBadge(): void {
    if (this.badge.classList.contains('hidden')) return;
    this.badge.classList.remove('compact');
    const label = this.label;
    const squeezed = label.scrollWidth > label.clientWidth + 1 && label.clientWidth < 64;
    const text = this.badgeText;
    const cut = text.scrollWidth > text.clientWidth + 1 && text.clientWidth < 56;
    const overflow = this.el.scrollWidth > this.el.clientWidth + 1;
    if (squeezed || cut || overflow) this.badge.classList.add('compact');
  }
}

export class List {
  readonly el: HTMLElement;
  private listbox: HTMLElement;
  private cursorHeader: HTMLButtonElement;
  private cursorMeta: HTMLElement;
  private cursorBody: HTMLElement;
  private pinHeader: HTMLButtonElement;
  private pinCount: HTMLElement;
  private pinBody: HTMLElement;
  private pinEmpty: HTMLElement;
  /** Fixed region above the scroller: the CURSOR section (when it is small). */
  private top: HTMLElement;
  /** The scroll container: PINNED (sticky header) and, when it is tall, the CURSOR section too. */
  private scroll: HTMLElement;
  /** Shadow under the fixed region / the stuck PINNED header when rows are hidden above. */
  private shadowTop: HTMLElement;
  private shadowBottom: HTMLElement;
  private lines = new Map<string, Line>();
  private order: Line[] = [];
  /** Selected ref at the previous render (scroll it into view when it changes). */
  private lastSelected = '';

  constructor(private readonly d: ListDeps) {
    const sectionHeader = (title: string, key: 'cursor' | 'pinned') => {
      const b = h('button.section-header', { type: 'button', 'aria-expanded': 'true', tabindex: -1 }, iconEl('chevron', 'section-chevron'), h('span.section-title', null, title));
      b.addEventListener('click', () => {
        this.d.ui.data.collapsed[key] = !this.d.ui.data.collapsed[key];
        this.d.ui.save();
        this.render();
      });
      return b;
    };
    this.cursorHeader = sectionHeader('Cursor', 'cursor');
    this.cursorMeta = h('span.section-meta');
    this.cursorHeader.append(this.cursorMeta);
    this.pinHeader = sectionHeader('Pinned', 'pinned');
    this.pinHeader.classList.add('pin-header');
    this.pinCount = h('span.count-badge');
    this.pinHeader.append(this.pinCount);
    this.cursorHeader.classList.add('cursor-header');
    this.cursorBody = h('div.section-body.cursor-body', { role: 'group', 'aria-label': 'Value at cursor' });
    this.pinBody = h('div.section-body', { role: 'group', 'aria-label': 'Pinned values' });
    this.pinEmpty = h(
      'div.pins-empty',
      null,
      'No pinned values. Use ',
      iconEl('pin', 'inline-icon'),
      ' on the cursor row to keep a value here.',
    );
    // The CURSOR section sits above the scroller, so a pin row can never be
    // half-hidden under it; the PINNED header (with its count) sticks at the
    // top of the scroller. A tall cursor section (an expanded multi) moves
    // into the scroller instead so it cannot eat the pins' room.
    this.top = h('div.list-top', null, this.cursorHeader, this.cursorBody);
    this.scroll = h('div.list-scroll', null, this.pinHeader, this.pinBody);
    this.listbox = h('div.listbox', { role: 'listbox', tabindex: 0, 'aria-label': 'Values' }, this.top, this.scroll);
    this.shadowTop = h('div.scroll-shadow.top', { 'aria-hidden': 'true' });
    this.shadowBottom = h('div.scroll-shadow.bottom', { 'aria-hidden': 'true' });
    this.el = h('section.list', { 'aria-label': 'Values list' }, this.listbox, this.shadowTop, this.shadowBottom);
    this.wire();
    this.scroll.addEventListener('scroll', () => this.updateShadows(), { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        this.updateShadows();
        for (const l of this.order) l.fitBadge();
      }).observe(this.el);
    }
  }

  private wire(): void {
    this.listbox.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const btn = t.closest<HTMLButtonElement>('.row-action');
      const lineEl = t.closest<HTMLElement>('.line');
      const line = lineEl ? this.lines.get(lineEl.id) : undefined;
      if (!line) return;
      if (btn) {
        e.stopPropagation();
        this.runAction(line, btn.dataset.action as Action);
        return;
      }
      if (t.closest('.twistie.collapsible')) {
        this.toggleExpanded(line.model.row);
        return;
      }
      this.selectLine(line);
    });
    this.listbox.addEventListener('dblclick', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.num, .row-action, .twistie, .inline-edit')) return;
      const lineEl = t.closest<HTMLElement>('.line');
      const line = lineEl ? this.lines.get(lineEl.id) : undefined;
      if (line && line.model.row.status !== 'noEditor' && line.model.row.status !== 'empty') this.d.post({ type: 'reveal', ref: line.model.ref });
    });
    this.listbox.addEventListener('keydown', (e) => this.onKey(e));
    this.listbox.addEventListener('focus', () => this.updateActiveDescendant());
  }

  private selectLine(line: Line): void {
    if (sameRef(this.d.store.selected.ref, line.model.ref)) return;
    this.d.select(line.model.ref);
  }

  private runAction(line: Line, action: Action): void {
    const m = line.model;
    switch (action) {
      case 'pin':
      case 'pinChild':
        this.d.post({ type: 'pin', ref: m.ref });
        break;
      case 'unpinCursor':
        if (m.row.pinnedAs) this.d.post({ type: 'unpin', pinId: m.row.pinnedAs });
        break;
      case 'unpin':
        this.d.post({ type: 'unpin', pinId: m.row.id });
        if (sameRef(this.d.store.selected.ref, m.ref) || this.d.store.selected.ref.rowId === m.row.id) this.d.store.select({ rowId: CURSOR_ROW_ID });
        break;
    }
  }

  private isExpanded(row: RowState): boolean {
    const sel = this.d.store.selected.ref;
    return row.options.expanded ?? (row.kind === 'cursor' || sel.rowId === row.id);
  }

  private toggleExpanded(row: RowState, value?: boolean): void {
    const expanded = value ?? !this.isExpanded(row);
    if (expanded === this.isExpanded(row)) return;
    // Collapsing a row whose child is selected moves the selection to the row.
    const sel = this.d.store.selected.ref;
    if (!expanded && sel.rowId === row.id && sel.childIndex !== undefined) this.d.select({ rowId: row.id });
    this.d.store.patchOptions(row.id, { expanded });
    this.d.post({ type: 'setRowOptions', rowId: row.id, options: { expanded } });
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('.inline-edit')) return;
    const cur = this.order.findIndex((l) => l.model.selected);
    const line = this.order[cur];
    const go = (i: number) => {
      const l = this.order[Math.max(0, Math.min(this.order.length - 1, i))];
      if (l) {
        this.selectLine(l);
        l.el.scrollIntoView({ block: 'nearest' });
      }
    };
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (e.altKey && line && line.model.row.kind === 'pin' && line.model.depth === 0) {
          this.movePin(line.model.row.id, e.key === 'ArrowUp' ? -1 : 1);
        } else go(cur + (e.key === 'ArrowDown' ? 1 : -1));
        break;
      }
      case 'Home':
        go(0);
        break;
      case 'End':
        go(this.order.length - 1);
        break;
      case 'ArrowRight':
        if (line && line.model.twistie === 'closed') this.toggleExpanded(line.model.row, true);
        else if (line && line.model.twistie === 'open') go(cur + 1);
        break;
      case 'ArrowLeft':
        if (line && line.model.twistie === 'open') this.toggleExpanded(line.model.row, false);
        else if (line && line.model.depth === 1) this.d.select({ rowId: line.model.row.id });
        break;
      case 'Enter':
        if (line) this.d.post({ type: 'reveal', ref: line.model.ref });
        break;
      case 'p':
      case 'P':
        if (!line || e.ctrlKey || e.metaKey || e.altKey) return;
        if (line.model.action) this.runAction(line, line.model.action.action);
        break;
      case 'Delete':
      case 'Backspace':
        if (line && line.model.row.kind === 'pin') this.runAction(line, 'unpin');
        break;
      case 'Escape':
        if (this.d.bridge.busy) return;
        this.d.backToCursor();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  private movePin(id: string, delta: number): void {
    const ids = this.d.store.rows.filter((r) => r.kind === 'pin').map((r) => r.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    this.d.post({ type: 'reorderPins', pinIds: ids });
  }

  /** Scrubbing a number in a row preview: horizontal drag changes it, dblclick types. */
  wireScrub(line: Line, span: HTMLElement): void {
    let g: Gesture | null = null;
    let values: (number | null)[] = [];
    let comp = 0;
    let text = '';
    let integer = false;
    let decimals = 1;
    draggable(span, {
      threshold: 3,
      pointerLock: true,
      start: (e, down) => {
        const m = line.model;
        // `e` is the pointermove that passed the threshold (button -1): the press decides.
        if (!m.target || down.button !== 0) return false;
        comp = Number(span.dataset.comp);
        const c = m.target.components[m.target.splat ? 0 : comp];
        if (!c?.editable) return false;
        this.d.store.resets.capture(m.target);
        values = fullValues(m.target);
        text = c.text;
        integer = !!c.integer;
        decimals = scrubDecimals(text, scrubStep(text, integer, e), integer);
        line.scrubbing = true;
        g = this.d.bridge.begin(m.ref);
      },
      move: (e) => {
        if (!g?.alive) return;
        const step = scrubStep(text, integer, e);
        decimals = Math.max(decimals, scrubDecimals(text, step, integer));
        const cur = values[comp] ?? 0;
        const next = Number((cur + e.movementX * step).toFixed(Math.min(6, decimals)));
        if (next === cur) return;
        values = values.slice();
        values[comp] = next;
        g.update(values, decimals);
        span.textContent = formatDisplay(next, shownDecimals(next, displayDecimals(text, integer)));
      },
      end: (_e, cancelled) => {
        line.scrubbing = false;
        g?.end(!cancelled);
        g = null;
        this.render();
      },
    });
    span.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.inlineEdit(line, span);
    });
  }

  private inlineEdit(line: Line, span: HTMLElement): void {
    const m = line.model;
    if (!m.target) return;
    const comp = Number(span.dataset.comp);
    const c = m.target.components[m.target.splat ? 0 : comp];
    if (!c?.editable) return;
    this.d.store.resets.capture(m.target);
    const input = h('input.inline-edit', { type: 'text', 'aria-label': 'Value', spellcheck: 'false' });
    input.value = String(expandedValues(m.target)[comp]);
    line.editing = true;
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const v = parseNumber(input.value);
      line.editing = false;
      input.replaceWith(span);
      if (commit && v !== null && line.model.target) {
        const values = fullValues(line.model.target);
        values[comp] = v;
        // Exponent aware: `1e-5` / `1.5e-5` must not be written as `0.0`.
        this.d.bridge.once(line.model.ref, values, typedDecimals(v, input.value));
      }
      this.render();
      this.listbox.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  private lineFor(domId: string): Line {
    let l = this.lines.get(domId);
    if (!l) {
      l = new Line(this, domId);
      this.lines.set(domId, l);
    }
    return l;
  }

  private modelsFor(row: RowState): LineModel[] {
    const store = this.d.store;
    const sel = store.selected.ref;
    const t = row.target;
    const hasChildren = !!t?.children?.length && row.status === 'ok';
    const expanded = hasChildren && this.isExpanded(row);
    let label = row.label;
    let labelTone: LineModel['labelTone'];
    if (row.kind === 'cursor') {
      if (row.status === 'noEditor') {
        label = 'Open a GLSL file';
        labelTone = 'muted';
      } else if (row.status === 'empty') {
        label = 'No value at cursor';
        labelTone = 'muted';
      }
    }
    if (row.status === 'stale') labelTone = 'stale';
    const where = row.fileName ? `${row.fileName}${row.line ? `:${row.line}` : ''}` : '';
    let title = [t?.snippet && t.snippet !== label ? t.snippet : '', where].filter(Boolean).join(' — ');
    if (row.status === 'stale') title = 'The pinned value could not be found. Double-click to go to its last location.';
    if (row.kind === 'cursor' && sel.rowId !== CURSOR_ROW_ID) title = ['Click to follow the cursor again (Esc)', title].filter(Boolean).join('\n');

    let action: ActionModel | undefined;
    if (row.kind === 'cursor') {
      if (row.status === 'ok') {
        action = row.pinnedAs
          ? { action: 'unpinCursor', icon: 'pinned', label: 'Unpin', title: 'Pinned — click to unpin (P)', always: true }
          : { action: 'pin', icon: 'pin', label: 'Pin value', title: 'Pin this value (P)', always: true };
      }
    } else action = { action: 'unpin', icon: 'close', label: 'Unpin', title: 'Unpin (Delete)' };

    const models: LineModel[] = [
      {
        domId: `row-${row.id}`,
        ref: { rowId: row.id },
        row,
        target: row.status === 'ok' ? t : undefined,
        depth: 0,
        twistie: hasChildren ? (expanded ? 'open' : 'closed') : 'none',
        label,
        labelTone,
        title,
        badge: !row.inActiveFile && row.fileName && row.status !== 'noEditor' ? row.fileName : undefined,
        preview: previewSpec(row, row.status === 'ok' ? t : undefined),
        action,
        selected: sameRef(sel, { rowId: row.id }),
      },
    ];
    if (expanded && t?.children) {
      t.children.forEach((child, i) => {
        const ref = { rowId: row.id, childIndex: i };
        models.push({
          domId: `row-${row.id}-c${i}`,
          ref,
          row,
          target: child,
          depth: 1,
          twistie: 'none',
          label: childLabel(t, i),
          title: child.snippet,
          preview: previewSpec(undefined, child),
          action:
            row.kind === 'cursor' && !child.implicit ? { action: 'pinChild', icon: 'pin', label: `Pin ${childLabel(t, i)}`, title: 'Pin only this value' } : undefined,
          selected: sameRef(sel, ref),
        });
      });
    }
    return models;
  }

  render(): void {
    const store = this.d.store;
    const rows = store.rows;
    const collapsed = this.d.ui.data.collapsed;
    const cursor = rows.find((r) => r.id === CURSOR_ROW_ID);
    const pins = rows.filter((r) => r.kind === 'pin');
    const used = new Set<string>();
    this.order = [];
    /** A newly added pin: scrolled into view (the list scrolls on its own). */
    let reveal: HTMLElement | undefined;

    const fill = (body: HTMLElement, list: RowState[], hidden: boolean) => {
      const els: HTMLElement[] = [];
      if (!hidden) {
        for (const row of list) {
          for (const m of this.modelsFor(row)) {
            const line = this.lineFor(m.domId);
            line.update(m);
            used.add(m.domId);
            els.push(line.el);
            this.order.push(line);
            if (m.depth === 0 && store.newPins.has(row.id)) {
              line.el.classList.remove('flash');
              void line.el.offsetWidth;
              line.el.classList.add('flash');
              reveal = line.el;
            }
          }
        }
      }
      // Reorder/patch children without recreating them.
      els.forEach((el, i) => {
        if (body.children[i] !== el) body.insertBefore(el, body.children[i] ?? null);
      });
      while (body.children.length > els.length) body.lastElementChild!.remove();
    };

    // Section headers
    const cCollapsed = !!collapsed.cursor;
    const pCollapsed = !!collapsed.pinned;
    toggle(this.cursorHeader, 'collapsed', cCollapsed);
    setAttr(this.cursorHeader, 'aria-expanded', cCollapsed ? 'false' : 'true');
    toggle(this.pinHeader, 'collapsed', pCollapsed);
    setAttr(this.pinHeader, 'aria-expanded', pCollapsed ? 'false' : 'true');
    const fileMeta = cursor?.status === 'ok' && cursor.fileName ? `${cursor.fileName}${cursor.line ? `:${cursor.line}` : ''}` : (store.state?.activeFileName ?? '');
    setText(this.cursorMeta, fileMeta);
    setText(this.pinCount, pins.length ? String(pins.length) : '');
    toggle(this.pinCount, 'hidden', !pins.length);

    fill(this.cursorBody, cursor ? [cursor] : [], cCollapsed);
    fill(this.pinBody, pins, pCollapsed);
    if (!pins.length && !pCollapsed) this.pinBody.append(this.pinEmpty);
    else this.pinEmpty.remove();

    store.newPins.clear(); // flash once per new pin
    for (const [id, l] of this.lines) if (!used.has(id)) {
      l.el.remove();
      this.lines.delete(id);
    }
    this.updateActiveDescendant();
    for (const l of this.order) l.fitBadge();
    toggle(this.el, 'many', this.order.length > 5);
    // The cursor section stays fixed above the scrolling pins (when it is small enough).
    const split = cCollapsed || this.cursorBody.children.length <= 3;
    const home = split ? this.top : this.scroll;
    if (this.cursorHeader.parentElement !== home) home.prepend(this.cursorHeader, this.cursorBody);
    toggle(this.el, 'split', split);

    // Keep the selected row (changed from the widget, the extension or a click) and new pins visible.
    // After the widget below re-rendered (its height decides how much room the list has).
    const selKey = refKey(store.selected.ref);
    const selLine = this.order.find((l) => l.model.selected);
    const target = reveal ?? (selKey !== this.lastSelected ? selLine?.el : undefined);
    this.lastSelected = selKey;
    if (target) requestAnimationFrame(() => this.scrollIntoList(target));
    this.updateShadows();
  }

  /** Scrolls the list (only the list, never the page) so `el` is fully visible. */
  private scrollIntoList(el: HTMLElement): void {
    if (!el.isConnected || !this.scroll.contains(el)) return;
    const sc = this.scroll;
    const sr = sc.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // The sticky PINNED header covers the top of the scrolled area for pin rows.
    const top = sr.top + (this.pinBody.contains(el) ? this.pinHeader.offsetHeight : 0);
    if (r.top < top) sc.scrollTop -= top - r.top + 2;
    else if (r.bottom > sr.bottom) sc.scrollTop += r.bottom - sr.bottom + 2;
    this.updateShadows();
  }

  /**
   * Scroll shadows (VS Code's scrollbar shadow): under the fixed CURSOR
   * section, or under the stuck PINNED header, when rows are hidden above;
   * at the bottom when rows are hidden below.
   */
  private updateShadows(): void {
    const sc = this.scroll;
    const above = sc.scrollTop > 0;
    let y = sc.offsetTop;
    let stuck = false;
    if (above) {
      stuck = this.pinHeader.getBoundingClientRect().top <= sc.getBoundingClientRect().top + 0.5;
      if (stuck) y += this.pinHeader.offsetHeight;
    }
    toggle(this.pinHeader, 'stuck', stuck);
    this.shadowTop.style.top = `${y}px`;
    toggle(this.shadowTop, 'visible', above);
    toggle(this.shadowBottom, 'visible', sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1);
  }

  private updateActiveDescendant(): void {
    const sel = this.order.find((l) => l.model.selected);
    setAttr(this.listbox, 'aria-activedescendant', sel ? sel.el.id : null);
  }

  focus(): void {
    this.listbox.focus();
  }

  /** Key of the selected ref (for tests / debugging). */
  get selectedKey(): string {
    return refKey(this.d.store.selected.ref);
  }
}
