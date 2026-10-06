// Pure: turns component values into replacement text for a value target.
// No `vscode` import (unit-tested in test/values.client.editText.test.ts).
//
// Model: an edit gesture owns a SPAN of the document (the target range). The
// text of the span is snapshotted at editBegin; every update rebuilds the whole
// span text from the snapshot + the latest values and replaces the current
// span. That keeps offset bookkeeping trivial (only the span length changes)
// and makes "restore" and "cancel" exact.

import { MAX_DECIMALS, formatFloat, formatInt, literalDecimals } from '../../../shared/valuesMath';
import { componentCount, type Range, type ValueTarget } from '../../../shared/valuesProtocol';

export interface SlotSpec {
  /** Absolute offsets in the document at snapshot time. */
  start: number;
  end: number;
  /** Source text of the slot (used for suffix preservation). */
  text: string;
  value: number;
  editable: boolean;
  integer?: boolean;
}

export interface GroupSpec {
  slots: SlotSpec[];
  /** Single-argument constructor `vecN(x)`: number of components when expanded. */
  splatN?: number;
  /**
   * A bare scalar standing for a vector (iq palette `0.5 + 0.5 * cos(...)`):
   * the constructor to wrap the components in once they differ (`vec3`).
   */
  wrap?: string;
}

export type TargetLike = Pick<ValueTarget, 'kind' | 'splat' | 'components' | 'children' | 'range'> & Partial<Pick<ValueTarget, 'ctor'>>;
type Pos = Range['start'];

export function buildGroups(t: TargetLike, offsetAt: (p: Pos) => number): GroupSpec[] {
  if ((t.kind === 'multi' || t.kind === 'palette') && t.children) {
    return t.children.flatMap((c) => buildGroups(c, offsetAt));
  }
  const slots: SlotSpec[] = t.components.map((c) => ({
    start: offsetAt(c.range.start),
    end: offsetAt(c.range.end),
    text: c.text,
    value: c.value,
    editable: c.editable,
    integer: c.integer,
  }));
  const group: GroupSpec = { slots };
  if (t.splat && t.components.length === 1) {
    group.splatN = Math.max(1, componentCount(t.kind));
    // A splat without a constructor is a scalar written for a vector.
    if (!t.ctor && t.kind !== 'float') group.wrap = t.kind;
  }
  return [group];
}

/** Union span of the target range and every slot. */
export function spanOf(t: TargetLike, groups: GroupSpec[], offsetAt: (p: Pos) => number): { start: number; end: number } {
  let start = offsetAt(t.range.start);
  let end = offsetAt(t.range.end);
  for (const g of groups)
    for (const s of g.slots) {
      if (s.start < start) start = s.start;
      if (s.end > end) end = s.end;
    }
  return { start, end };
}

/** Number of values a values array carries for these groups (layout A: splat groups expand). */
export function expectedValueCount(groups: GroupSpec[]): number {
  return groups.reduce((n, g) => n + (g.splatN ?? g.slots.length), 0);
}

function suffixOf(text: string): string {
  const m = /(?:lf|LF|[fFuU])$/.exec(text.trim());
  return m ? m[0] : '';
}

/**
 * Formats a slot value. The slot's own precision raises the decimals cap
 * (`0.00025` stays exact under maxDecimals 4) and an exponent literal keeps
 * its style (`1e-5`); tiny values never collapse to `0.0`.
 */
function fmt(integer: boolean | undefined, v: number, decimals: number, maxDecimals: number, slotText = ''): string {
  if (integer) return formatInt(v);
  const body = slotText.trim().replace(/(?:lf|LF|[fF])$/, '');
  const own = body ? Math.min(MAX_DECIMALS, literalDecimals(body)) : 0;
  return formatFloat(v, decimals, Math.max(maxDecimals, own), { exponent: /\d[eE][+-]?\d/.test(body) });
}

/**
 * True when `text` sits in the document as a complete number token: the
 * expected text and no word/number character glued on either side (a stale
 * slot `0.5` over a document that now reads `0.55` fails).
 */
export function slotIntact(before: string, text: string, after: string, expected: string): boolean {
  if (text !== expected) return false;
  if (before && /[\w.]/.test(before)) return false;
  if (after && /[\w.]/.test(after)) return false;
  return true;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

/**
 * Rebuilds the span text. `snapshot` is the span's original text starting at
 * `spanStart`; `charBefore` the document character right before the span (used
 * to avoid writing `--`). Returns the new span text.
 */
export function buildReplacement(
  snapshot: string,
  spanStart: number,
  groups: GroupSpec[],
  values: readonly (number | null)[],
  decimals: number,
  maxDecimals: number,
  charBefore = '',
): string {
  // Layout A (splat groups consume N values) unless the array only matches layout B (one per slot).
  const totalA = expectedValueCount(groups);
  const totalB = groups.reduce((n, g) => n + g.slots.length, 0);
  const useB = values.length === totalB && values.length !== totalA;

  const reps: Replacement[] = [];
  let cursor = 0;
  for (const g of groups) {
    let n = useB ? g.slots.length : (g.splatN ?? g.slots.length);
    if (g.splatN && !useB && groups.length === 1 && values.length === 1) n = 1;
    const vals = values.slice(cursor, cursor + n);
    cursor += n;

    if (g.splatN && g.slots.length === 1) {
      const slot = g.slots[0];
      if (!slot.editable || vals.length === 0 || vals.every((v) => v === null || v === undefined)) continue;
      const texts = vals.map((v) => fmt(slot.integer, v === null || v === undefined ? slot.value : v, decimals, maxDecimals, slot.text));
      const sfx = suffixOf(slot.text);
      let text: string;
      if (texts.every((t) => t === texts[0])) {
        text = Number(texts[0]) === slot.value ? slot.text : texts[0] + sfx;
      } else {
        text = texts.map((t) => t + sfx).join(', ');
        if (g.wrap) text = `${g.wrap}(${text})`;
      }
      if (text !== slot.text) reps.push({ start: slot.start, end: slot.end, text });
      continue;
    }

    g.slots.forEach((slot, i) => {
      const v = vals[i];
      if (v === null || v === undefined || !slot.editable || !Number.isFinite(v)) return;
      const text = fmt(slot.integer, v, decimals, maxDecimals, slot.text);
      if (v === slot.value || Number(text) === slot.value) return; // keep the user's own formatting
      reps.push({ start: slot.start, end: slot.end, text: text + suffixOf(slot.text) });
    });
  }

  reps.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const r of reps) {
    const rs = r.start - spanStart;
    const re = r.end - spanStart;
    if (rs < pos || re > snapshot.length || rs < 0) continue; // overlapping or outside: ignore defensively
    out += snapshot.slice(pos, rs);
    let text = r.text;
    const prev = out.length > 0 ? out[out.length - 1] : charBefore;
    if (text.startsWith('-') && (prev === '-' || prev === '+')) text = ' ' + text;
    out += text;
    pos = re;
  }
  out += snapshot.slice(pos);
  return out;
}

export type ChangeKind = { kind: 'before'; shift: number } | { kind: 'after' } | { kind: 'intersect' };

/**
 * Classifies a document change against a gesture span (absolute offsets; the
 * change replaces [changeStart, changeStart+changeLen) by `newLen` chars).
 * Touching the span edges counts as intersecting.
 */
export function classifyChange(spanStart: number, spanLen: number, changeStart: number, changeLen: number, newLen: number): ChangeKind {
  const changeEnd = changeStart + changeLen;
  if (changeEnd < spanStart) return { kind: 'before', shift: newLen - changeLen };
  if (changeStart > spanStart + spanLen) return { kind: 'after' };
  return { kind: 'intersect' };
}
