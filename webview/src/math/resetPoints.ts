// Reset points: the value a target had when it was first selected or first
// edited in this session. Keyed by the target (document + target id), not by
// the widget instance, so rebuilding a widget (cursor <-> pin, mode switch,
// a re-render after an edit) never moves the reset point to the edited value.

import type { ValueTarget } from '../../../shared/valuesProtocol';
import { expandedValues } from './targets';

export class ResetPoints {
  private map = new Map<string, number[]>();

  constructor(private readonly max = 256) {}

  static key(t: Pick<ValueTarget, 'uri' | 'id'>): string {
    return `${t.uri}#${t.id}`;
  }

  /** The reset point of `t`, captured from its current values on first use. */
  capture(t: ValueTarget): number[] {
    const key = ResetPoints.key(t);
    const now = expandedValues(t);
    const had = this.map.get(key);
    // A different value shape at the same place (the text was rewritten): start over.
    if (had && had.length === now.length) return had;
    this.map.set(key, now);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    return now;
  }

  /**
   * The same target got a new id (text edited above it moved it): keep its
   * reset point (children too, for palette/multi rows).
   */
  follow(prev: ValueTarget, next: ValueTarget): void {
    if (prev === next) return;
    const k = ResetPoints.key(next);
    const p = this.map.get(ResetPoints.key(prev));
    if (p && !this.map.has(k) && prev.kind === next.kind) this.map.set(k, p);
    const pc = prev.children ?? [];
    const nc = next.children ?? [];
    if (pc.length === nc.length) pc.forEach((c, i) => this.follow(c, nc[i]));
  }

  /** The reset point when one was captured. */
  get(t: Pick<ValueTarget, 'uri' | 'id'>): number[] | undefined {
    return this.map.get(ResetPoints.key(t));
  }
}

/** Whether `v` differs from the reset value `r` (beyond float noise). */
export function differsFrom(v: number, r: number | undefined): boolean {
  if (r === undefined || !Number.isFinite(r) || !Number.isFinite(v)) return false;
  return Math.abs(v - r) > 1e-9 * Math.max(1, Math.abs(r));
}
