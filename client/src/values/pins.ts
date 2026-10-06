// Pin store backed by a Memento-like object (workspaceState). No `vscode`
// import: the Memento is a structural interface so tests can fake it.

import { PINS_STATE_KEY, type ChildKey, type PinAnchor, type RowOptions, type StoredPin, type ValueTarget } from '../../../shared/valuesProtocol';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export function newPinId(random: () => number = Math.random): string {
  let s = '';
  while (s.length < 8) s += Math.floor(random() * 36).toString(36);
  return 'p_' + s;
}

/** Stable key for per-anchor memory (cursor row options). */
export function anchorKey(a: PinAnchor): string {
  return [a.uri, a.kind, a.declKind ?? '', a.declName ?? '', a.functionName ?? '', a.fingerprint, a.ordinal].join('|');
}

/** Same stored anchor (every field: position, fingerprint, text, context, flags). */
function sameAnchor(a: PinAnchor, b: PinAnchor): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof PinAnchor>;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function isStoredPin(p: unknown): p is StoredPin {
  const x = p as StoredPin | undefined;
  return !!x && typeof x.id === 'string' && !!x.anchor && typeof x.anchor.uri === 'string' && typeof x.anchor.kind === 'string';
}

export class PinStore {
  private pins: StoredPin[];
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly memento: MementoLike,
    private readonly saveDelayMs = 500,
  ) {
    const raw = memento.get<unknown>(PINS_STATE_KEY);
    this.pins = Array.isArray(raw) ? raw.filter(isStoredPin).map((p) => ({ ...p, options: p.options ?? {} })) : [];
  }

  list(): readonly StoredPin[] {
    return this.pins;
  }

  get(id: string): StoredPin | undefined {
    return this.pins.find((p) => p.id === id);
  }

  get size(): number {
    return this.pins.length;
  }

  add(anchor: PinAnchor, label: string, options: RowOptions = {}, childIndex?: number, now = Date.now(), child?: ChildKey): StoredPin {
    const pin: StoredPin = { id: newPinId(), anchor, label, options: { ...options }, createdAt: now };
    if (childIndex !== undefined) pin.childIndex = childIndex;
    if (child) pin.child = child;
    this.pins = [...this.pins, pin];
    this.saveSoon();
    return pin;
  }

  remove(id: string): boolean {
    const n = this.pins.length;
    this.pins = this.pins.filter((p) => p.id !== id);
    if (this.pins.length === n) return false;
    this.saveSoon();
    return true;
  }

  clear(): void {
    this.pins = [];
    this.saveSoon();
  }

  /** New order from a list of ids; unknown ids are ignored, missing ones keep their relative order at the end. */
  reorder(ids: readonly string[]): void {
    const byId = new Map(this.pins.map((p) => [p.id, p]));
    const ordered: StoredPin[] = [];
    for (const id of ids) {
      const p = byId.get(id);
      if (p) {
        ordered.push(p);
        byId.delete(id);
      }
    }
    for (const p of this.pins) if (byId.has(p.id)) ordered.push(p);
    this.pins = ordered;
    this.saveSoon();
  }

  setOptions(id: string, options: RowOptions): void {
    const p = this.get(id);
    if (!p) return;
    p.options = mergeOptions(p.options, options);
    this.saveSoon();
  }

  /** Stores a refreshed anchor / label after a successful resolution. Saves only when something changed. */
  refresh(id: string, anchor: PinAnchor, label?: string): void {
    const p = this.get(id);
    if (!p) return;
    let changed = false;
    if (!sameAnchor(p.anchor, anchor)) {
      p.anchor = anchor;
      changed = true;
    }
    if (label !== undefined && label !== p.label) {
      p.label = label;
      changed = true;
    }
    if (changed) this.saveSoon();
  }

  /** A child pin was found again (possibly at another index / with another value). */
  refreshChild(id: string, index: number, key: ChildKey): void {
    const p = this.get(id);
    if (!p) return;
    const k = p.child;
    const same = p.childIndex === index && !!k && k.sig === key.sig && k.fromEnd === key.fromEnd && k.total === key.total && k.name === key.name;
    if (same) return;
    p.childIndex = index;
    p.child = key;
    this.saveSoon();
  }

  /**
   * Follows line insertions/deletions in a document so the stored line of
   * every pin of `uri` stays on its target between resolutions.
   */
  shiftLines(uri: string, changes: readonly LineChange[]): void {
    let changed = false;
    for (const p of this.pins) {
      if (p.anchor.uri !== uri) continue;
      const next = shiftAnchor(p.anchor, changes);
      if (next !== p.anchor) {
        p.anchor = next;
        changed = true;
      }
    }
    if (changed) this.saveSoon();
  }

  /** Pin with the same uri + child index whose stored anchor equals `anchor` (cheap duplicate check). */
  findByAnchor(anchor: PinAnchor, childIndex?: number): StoredPin | undefined {
    return this.pins.find((p) => p.childIndex === childIndex && p.anchor.uri === anchor.uri && anchorKey(p.anchor) === anchorKey(anchor));
  }

  private saveSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), this.saveDelayMs);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.memento.update(PINS_STATE_KEY, this.pins);
  }

  dispose(): void {
    if (this.saveTimer) void this.flush();
  }
}

/** Merges options; explicit `undefined` values clear a key. */
export function mergeOptions(base: RowOptions, patch: RowOptions): RowOptions {
  const out: RowOptions = { ...base };
  for (const key of Object.keys(patch) as (keyof RowOptions)[]) {
    const v = patch[key];
    if (v === undefined) delete out[key];
    else (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

/** A document change in line/character terms (TextDocumentContentChangeEvent shape). */
export interface LineChange {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  text: string;
}

/**
 * Moves an anchor's line/character over document changes (all ranges refer to
 * the pre-change document, as in one change event). A change overlapping the
 * anchor position leaves it alone (resolution finds it). Returns the same
 * object when nothing moved.
 */
export function shiftAnchor(anchor: PinAnchor, changes: readonly LineChange[]): PinAnchor {
  let dLine = 0;
  let column: number | undefined;
  let strict = false;
  const cmp = (p: { line: number; character: number }) => p.line - anchor.line || p.character - anchor.character;
  for (const c of changes) {
    const { start, end } = c.range;
    const before = cmp(end) <= 0;
    if (!before) {
      // A multi-line edit across the pinned position removed or replaced its line as a whole.
      if (cmp(start) <= 0 && (end.line > start.line || c.text.includes('\n'))) strict = true;
      continue;
    }
    const parts = c.text.split('\n');
    const added = parts.length - 1;
    dLine += added - (end.line - start.line);
    if (end.line === anchor.line) {
      // The change ends on the anchor line, left of the target: its column moves too.
      const tail = anchor.character - end.character;
      column = (added ? parts[parts.length - 1].length : start.character + c.text.length) + tail;
    }
  }
  const line = Math.max(0, anchor.line + dLine);
  const character = Math.max(0, column ?? anchor.character);
  if (line === anchor.line && character === anchor.character && (!strict || anchor.strict)) return anchor;
  const next: PinAnchor = { ...anchor, line, character };
  if (strict) next.strict = true;
  return next;
}

/** Component texts of a target: what a child pin is recognised by. */
export function childSig(t: Pick<ValueTarget, 'kind' | 'components'>): string {
  return `${t.kind}:${t.components.map((c) => c.text).join(',')}`;
}

export function childKeyOf(children: readonly ValueTarget[], index: number): ChildKey | undefined {
  const c = children[index];
  if (!c) return undefined;
  const key: ChildKey = { kind: c.kind, sig: childSig(c), fromEnd: children.length - 1 - index, total: children.length };
  if (c.name) key.name = c.name;
  return key;
}

/**
 * Finds a pinned child again among the parent's current children; -1 when it
 * is gone or ambiguous (the pin goes stale instead of retargeting).
 *  1. same component texts: unique -> it; several -> the one at the stored index (from start, then from end);
 *  2. value changed but same structure (same count) -> the stored index, when the kind matches;
 *  3. a unique child with the same name and kind.
 * Pins stored before `child` existed use the index.
 */
export function pickChild(children: readonly ValueTarget[], index: number, key: ChildKey | undefined): number {
  if (!key) return index >= 0 && index < children.length ? index : -1;
  const idx = children.map((_, i) => i).filter((i) => children[i].kind === key.kind);
  const fromEnd = children.length - 1 - key.fromEnd;
  const bySig = idx.filter((i) => childSig(children[i]) === key.sig);
  if (bySig.length === 1) return bySig[0];
  if (bySig.length > 1) {
    if (bySig.includes(index)) return index;
    if (bySig.includes(fromEnd)) return fromEnd;
    return -1;
  }
  if (children.length === key.total && children[index]?.kind === key.kind) return index;
  if (key.name) {
    const byName = idx.filter((i) => children[i].name === key.name);
    if (byName.length === 1) return byName[0];
  }
  return -1;
}
