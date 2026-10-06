// Webview state: the latest StateMessage, the (optimistic) selection, and
// optimistic value overrides for targets being edited, so neither the list
// nor the widget jump back while the extension catches up.

import type { RowOptions, RowState, StateMessage, TargetRef, ValueTarget, ValuesSettings } from '../../shared/valuesProtocol';
import { CURSOR_ROW_ID } from '../../shared/valuesProtocol';
import { ResetPoints } from './math/resetPoints';
import { applyValues, refKey, sameRef, valuesMatch } from './math/targets';

interface Override {
  ref: TargetRef;
  values: (number | null)[];
  decimals: number;
  /** A gesture is running: always applied. */
  active: boolean;
  /** When settling (gesture ended): drop after this time even if the state never matched. */
  expires: number;
}

const SETTLE_MS = 1500;

export const DEFAULT_SETTINGS: ValuesSettings = { throttleMs: 33, maxDecimals: 4 };

export class Store {
  private raw: StateMessage | null = null;
  private view: RowState[] = [];
  private overrides = new Map<string, Override>();
  private listeners = new Set<() => void>();
  selection: TargetRef = { rowId: CURSOR_ROW_ID };
  private localSelectAt = 0;
  /** Pin ids seen in the previous state (to flash new pins). */
  private knownPins: Set<string> | null = null;
  /** Pins that appeared in the latest state. */
  newPins = new Set<string>();
  /** Per-target reset points (first selection / first gesture). */
  readonly resets = new ResetPoints();

  get state(): StateMessage | null {
    return this.raw;
  }

  get settings(): ValuesSettings {
    return this.raw?.settings ?? DEFAULT_SETTINGS;
  }

  /** Rows with optimistic overrides applied. */
  get rows(): RowState[] {
    return this.view;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  setState(m: StateMessage): void {
    this.raw = m;
    // Keep a fresh local selection while the extension's echo is in flight.
    if (Date.now() - this.localSelectAt > 400 || sameRef(m.selection, this.selection)) this.selection = m.selection;
    // Settle overrides whose values the document now has (or that expired).
    const now = Date.now();
    for (const [key, o] of this.overrides) {
      if (o.active) continue;
      const t = this.rawTarget(o.ref);
      if (!t || now > o.expires || valuesMatch(t, o.values, o.decimals)) this.overrides.delete(key);
    }
    const pins = new Set(m.rows.filter((r) => r.kind === 'pin').map((r) => r.id));
    this.newPins = new Set(this.knownPins ? [...pins].filter((id) => !this.knownPins!.has(id)) : []);
    this.knownPins = pins;
    this.recompute();
  }

  /** Optimistic local selection (the extension echoes it in the next state). */
  select(ref: TargetRef): void {
    this.selection = { ...ref };
    this.localSelectAt = Date.now();
    this.emit();
  }

  /** Optimistic local options merge (the extension persists and echoes them). */
  patchOptions(rowId: string, options: RowOptions): void {
    const row = this.raw?.rows.find((r) => r.id === rowId);
    if (!row) return;
    row.options = { ...row.options, ...options };
    this.recompute();
  }

  row(id: string): RowState | undefined {
    return this.view.find((r) => r.id === id);
  }

  /** Target addressed by `ref`, with overrides. */
  target(ref: TargetRef): ValueTarget | undefined {
    const t = this.row(ref.rowId)?.target;
    if (!t) return undefined;
    return ref.childIndex === undefined ? t : t.children?.[ref.childIndex];
  }

  private rawTarget(ref: TargetRef): ValueTarget | undefined {
    const t = this.raw?.rows.find((r) => r.id === ref.rowId)?.target;
    if (!t) return undefined;
    return ref.childIndex === undefined ? t : t.children?.[ref.childIndex];
  }

  /** The selected row/target, falling back to the cursor row when the selection no longer exists. */
  get selected(): { ref: TargetRef; row: RowState | undefined; target: ValueTarget | undefined } {
    let ref = this.selection;
    let row = this.row(ref.rowId);
    if (!row) {
      ref = { rowId: CURSOR_ROW_ID };
      row = this.row(CURSOR_ROW_ID);
    }
    let target = row?.target;
    if (target && ref.childIndex !== undefined) {
      const child = target.children?.[ref.childIndex];
      if (child) target = child;
      else ref = { rowId: ref.rowId };
    }
    return { ref, row, target };
  }

  setOverride(ref: TargetRef, values: (number | null)[], decimals: number, active: boolean): void {
    this.overrides.set(refKey(ref), { ref: { ...ref }, values: [...values], decimals, active, expires: Date.now() + SETTLE_MS });
    this.recompute();
  }

  /** Gesture ended: keep the override until the document catches up. */
  settleOverride(ref: TargetRef): void {
    const o = this.overrides.get(refKey(ref));
    if (!o) return;
    o.active = false;
    o.expires = Date.now() + SETTLE_MS;
    // The state may already match.
    const t = this.rawTarget(ref);
    if (t && valuesMatch(t, o.values, o.decimals)) this.overrides.delete(refKey(ref));
    this.recompute();
  }

  clearOverride(ref: TargetRef): void {
    if (this.overrides.delete(refKey(ref))) this.recompute();
  }

  isEditing(ref: TargetRef): boolean {
    return this.overrides.get(refKey(ref))?.active ?? false;
  }

  private recompute(): void {
    const rows = this.raw?.rows ?? [];
    if (this.overrides.size === 0) {
      this.view = rows;
      this.emit();
      return;
    }
    this.view = rows.map((row) => {
      if (!row.target) return row;
      let target = row.target;
      for (const o of this.overrides.values()) {
        if (o.ref.rowId !== row.id) continue;
        if (o.ref.childIndex === undefined) target = applyValues(target, o.values);
        else if (target.children?.[o.ref.childIndex]) {
          const children = target.children.slice();
          children[o.ref.childIndex] = applyValues(children[o.ref.childIndex], o.values);
          target = { ...target, children };
        }
      }
      return target === row.target ? row : { ...row, target };
    });
    this.emit();
  }

  isSelected(ref: TargetRef): boolean {
    return sameRef(this.selected.ref, ref);
  }
}
