// Pure helpers over ValueTarget / TargetRef: widget choice, optimistic value
// patching, and comparisons. No DOM.

import type { RowOptions, TargetRef, ValueTarget } from '../../../shared/valuesProtocol';

export const refKey = (ref: TargetRef): string => (ref.childIndex === undefined ? ref.rowId : `${ref.rowId}#${ref.childIndex}`);

export const sameRef = (a: TargetRef | undefined, b: TargetRef | undefined): boolean =>
  !!a && !!b && a.rowId === b.rowId && a.childIndex === b.childIndex;

export type WidgetKind = 'slider' | 'trackpad' | 'color' | 'vector' | 'stack' | 'palette' | 'multi';

/** vec3/vec4 mode: the row's override, else the server's color heuristic. */
export function vecMode(target: ValueTarget, options: RowOptions | undefined): 'color' | 'vector' {
  return options?.mode ?? (target.colorish ? 'color' : 'vector');
}

/** True when every component is a plain editable float literal. */
export function allEditableFloats(target: ValueTarget): boolean {
  return target.components.length > 0 && target.components.every((c) => c.editable && !c.integer);
}

/** Which widget edits `target`. Vectors with locked or integer components fall back to a slider stack. */
export function chooseWidget(target: ValueTarget, options?: RowOptions): WidgetKind {
  switch (target.kind) {
    case 'float':
      return 'slider';
    case 'palette':
      return target.children?.length === 4 ? 'palette' : 'multi';
    case 'multi':
      return 'multi';
    case 'vec2':
      return allEditableFloats(target) ? 'trackpad' : 'stack';
    case 'vec3':
    case 'vec4':
      if (!allEditableFloats(target)) return 'stack';
      return vecMode(target, options);
  }
}

/** Number of components a vector target has once a splat is expanded. */
export function arity(target: ValueTarget): number {
  switch (target.kind) {
    case 'vec2':
      return 2;
    case 'vec3':
      return 3;
    case 'vec4':
      return 4;
    case 'float':
      return 1;
    default:
      return target.components.length;
  }
}

/**
 * Component values with splats expanded (`vec3(0.5)` -> [0.5, 0.5, 0.5]).
 * Locked components are NaN.
 */
export function expandedValues(target: ValueTarget): number[] {
  const n = arity(target);
  if (target.splat && target.components.length === 1) return new Array(n).fill(target.components[0].value);
  return target.components.map((c) => (c.editable ? c.value : NaN));
}

/** Flattened values in the EditUpdate layout: own components, or children concatenated (palette/multi). */
export function flatValues(target: ValueTarget): number[] {
  if (target.children && target.components.length === 0) return target.children.flatMap((c) => expandedValues(c));
  return expandedValues(target);
}

/**
 * Returns a copy of `target` whose component values are replaced by `values`
 * (EditUpdate layout; null = unchanged). A splat that receives N unequal
 * values is shown expanded (the extension rewrites the constructor too).
 */
export function applyValues(target: ValueTarget, values: readonly (number | null)[]): ValueTarget {
  if (target.children && target.components.length === 0) {
    let i = 0;
    const children = target.children.map((child) => {
      const n = target.kind === 'palette' ? 3 : child.splat ? arity(child) : child.components.length;
      const slice = values.slice(i, i + n);
      i += n;
      return applyValues(child, slice);
    });
    return { ...target, children };
  }
  if (target.splat && target.components.length === 1 && values.length > 1) {
    const base = target.components[0];
    const vals = values.map((v) => v ?? base.value);
    if (vals.every((v) => v === vals[0])) return { ...target, components: [{ ...base, value: vals[0] }] };
    return { ...target, splat: false, components: vals.map((v) => ({ ...base, value: v })) };
  }
  const components = target.components.map((c, i) => {
    const v = values[i];
    return v === null || v === undefined || !c.editable || !Number.isFinite(v) ? c : { ...c, value: v };
  });
  return { ...target, components };
}

/** True when the target's values equal `values` once both are rounded to `decimals`. */
export function valuesMatch(target: ValueTarget, values: readonly (number | null)[], decimals: number): boolean {
  const cur = flatValues(target);
  const eps = 0.5 * 10 ** -Math.max(0, Math.min(6, decimals)) + 1e-9;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    const c = cur[i];
    if (!Number.isFinite(c)) continue;
    if (Math.abs(c - v) > eps) return false;
  }
  return true;
}

/** Short type label for badges: `float`, `vec3`, `color3`, `palette`, `3 values`. */
export function typeLabel(target: ValueTarget): string {
  if (target.kind === 'multi') return `${target.children?.length ?? 0} values`;
  if (target.kind === 'palette') return 'palette';
  if (target.uniform?.declaredType) return target.uniform.declaredType;
  return target.ctor ?? target.kind;
}

/** Label for a child of a multi/palette (param name or `#n`). */
export function childLabel(parent: ValueTarget, i: number): string {
  const c = parent.children?.[i];
  if (parent.kind === 'palette') return c?.name ?? 'abcd'[i] ?? `#${i + 1}`;
  return c?.name ?? `#${i + 1}`;
}
