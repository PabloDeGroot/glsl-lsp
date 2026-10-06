// multi -> one compact slider per child (vector children link to their own
// widget); also the fallback for vectors with locked/integer components
// (one slider per component, locked ones read-only).

import type { ValueTarget } from '../../../shared/valuesProtocol';
import { formatDisplay } from '../../../shared/valuesMath';
import { EditSession } from '../bridge';
import { iconEl } from '../icons';
import { glyphSpec, renderGlyph } from '../list/preview';
import { displayDecimals, shownDecimals } from '../math/range';
import { childLabel, expandedValues } from '../math/targets';
import { h, setText } from '../ui/dom';
import { FloatControl } from './FloatSlider';
import type { Widget, WidgetContext } from './types';

interface Item {
  update(ctx: WidgetContext): void;
  dispose(): void;
  focusable(): HTMLElement | null;
}

const AXES = ['x', 'y', 'z', 'w'] as const;

export class SliderStack implements Widget {
  readonly el: HTMLElement;
  private items: Item[] = [];
  private ctx: WidgetContext;

  constructor(ctx: WidgetContext) {
    this.ctx = ctx;
    const t = ctx.target;
    const body = h('div.stack', { role: 'group', 'aria-label': 'Values' });
    if (t.children && t.components.length === 0) {
      t.children.forEach((child, i) => {
        const item = child.kind === 'float' ? this.floatChild(ctx, i) : this.vectorChild(ctx, i);
        this.items.push(item);
        body.append((item as unknown as { el: HTMLElement }).el);
      });
    } else {
      const ref = ctx.ref;
      const session = new EditSession(ctx.bridge, ref);
      const n = expandedValues(t).length;
      for (let i = 0; i < n; i++) {
        const comp = t.components[t.splat ? 0 : i];
        const ctl = new FloatControl({
          name: AXES[i] ?? `#${i + 1}`,
          label: (t.colorish ? 'RGBA' : 'XYZW')[i] ?? `${i + 1}`,
          axis: AXES[i],
          session,
          values: () => expandedValues(this.ctx.target).map((v) => (Number.isFinite(v) ? v : null)),
          index: i,
          integer: comp?.integer,
          uniform: t.uniform,
          compact: true,
          displayDecimals: () => {
            const tc = this.ctx.target.components[this.ctx.target.splat ? 0 : i];
            return displayDecimals(tc?.text, tc?.integer);
          },
        });
        const item: Item & { el: HTMLElement } = {
          el: h('div.stack-row', null, ctl.el),
          update: (c) => {
            session.ref = c.ref;
            if (session.dragging) return;
            const tc = c.target.components[c.target.splat ? 0 : i];
            const v = expandedValues(c.target)[i];
            ctl.set(v, !tc?.editable, tc?.text);
          },
          dispose: () => session.end(true),
          focusable: () => ctl.slider.el,
        };
        this.items.push(item);
        body.append(item.el);
      }
      if (t.components.some((c) => !c.editable)) body.append(h('div.widget-hint', null, iconEl('lock', 'inline-icon'), 'Some components are expressions and cannot be edited here.'));
    }
    this.el = h('div.w-stack', null, body);
    this.update(ctx);
  }

  private floatChild(ctx: WidgetContext, i: number): Item & { el: HTMLElement } {
    const ref = { rowId: ctx.ref.rowId, childIndex: i };
    const session = new EditSession(ctx.bridge, ref);
    const child = () => this.ctx.target.children?.[i];
    const c0 = child()!.components[0];
    const ctl = new FloatControl({
      name: childLabel(ctx.target, i),
      label: childLabel(ctx.target, i),
      session,
      values: () => [child()?.components[0]?.value ?? 0],
      index: 0,
      integer: c0.integer,
      uniform: child()?.uniform,
      compact: true,
      resetValue: () => {
        const t = child();
        return t ? this.ctx.resetPoint(t)[0] : undefined;
      },
      displayDecimals: () => {
        const c = child()?.components[0];
        return displayDecimals(c?.text, c?.integer);
      },
    });
    return {
      el: h('div.stack-row', null, ctl.el),
      update: () => {
        if (session.dragging) return;
        const c = child()?.components[0];
        if (c) ctl.set(c.value, !c.editable, c.text);
      },
      dispose: () => session.end(true),
      focusable: () => ctl.slider.el,
    };
  }

  private vectorChild(ctx: WidgetContext, i: number): Item & { el: HTMLElement } {
    const glyph = h('span.glyph');
    const nums = h('span.stack-nums');
    const open = h('button.icon-button.stack-open', { type: 'button', title: 'Edit with its own widget', 'aria-label': `Edit ${childLabel(ctx.target, i)}` }, iconEl('chevron'));
    open.addEventListener('click', () => this.ctx.select({ rowId: this.ctx.ref.rowId, childIndex: i }));
    const el = h(
      'div.stack-row.vector-child',
      null,
      h('div.float-main', null, h('span.stack-label', { title: childLabel(ctx.target, i) }, childLabel(ctx.target, i)), glyph, nums, open),
    );
    el.addEventListener('dblclick', () => open.click());
    return {
      el,
      update: () => {
        const c: ValueTarget | undefined = this.ctx.target.children?.[i];
        if (!c) return;
        renderGlyph(glyph, glyphSpec(undefined, c, undefined));
        setText(
          nums,
          expandedValues(c)
            .map((v, k) => {
              const comp = c.components[c.splat ? 0 : k];
              return Number.isFinite(v) ? formatDisplay(v, shownDecimals(v, displayDecimals(comp?.text, comp?.integer))) : (comp?.text ?? '?');
            })
            .join('  '),
        );
      },
      dispose: () => {},
      focusable: () => open,
    };
  }

  update(ctx: WidgetContext): void {
    this.ctx = ctx;
    for (const it of this.items) it.update(ctx);
  }

  focus(): void {
    this.items.find((i) => i.focusable())?.focusable()?.focus();
  }

  dispose(): void {
    for (const it of this.items) it.dispose();
  }
}
