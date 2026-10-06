// Per-model analysis: every value spec of a file (float literals, vector
// constructors, palettes), cached on the FileModel object (models are
// replaced on edit), plus statement helpers.

import type { FileModel } from '../../core';
import { findLiterals } from './literals';
import { findPalettes } from './palette';
import { scanTokens } from './scan';
import type { Analysis, FnRange, MultiGroup, Spec, STok } from './types';
import { findVectors } from './vectors';

const cache = new WeakMap<FileModel, Analysis>();

export function analyze(model: FileModel): Analysis {
  let a = cache.get(model);
  if (a) return a;
  a = build(model);
  cache.set(model, a);
  return a;
}

function build(model: FileModel): Analysis {
  const { seq, dirs, match, excluded } = scanTokens(model);
  const lits = findLiterals(seq, excluded);
  const vecs = findVectors(seq, match, lits);
  const palettes = findPalettes(seq, match, vecs, lits);

  // Literals that are not an editable slot of a vector / palette. A literal
  // inside a locked vector argument (`vec2(5.2, 1.3 - t * 0.15)`: 1.3, 0.15)
  // stays a float target of its own, so the cursor and multis can reach it.
  const containers = [...vecs, ...palettes].sort((x, y) => x.startTok - y.startTok || y.endTok - x.endTok);
  const inContainer = new Uint8Array(seq.length);
  for (const c of palettes) for (let i = c.startTok; i <= c.endTok; i++) inContainer[i] = 1;
  for (const c of vecs) {
    for (const arg of c.vec!.args) if (arg.lit) for (let i = arg.lit.startTok; i <= arg.lit.endTok; i++) inContainer[i] = 1;
  }
  const floats: Spec[] = [];
  for (const lit of lits.values()) {
    if (inContainer[lit.endTok]) continue;
    floats.push({ kind: 'float', startTok: lit.startTok, endTok: lit.endTok, start: lit.start, end: lit.end, top: true, lit, integer: lit.integer });
  }

  // top = not nested in another container (sweep).
  const stack: Spec[] = [];
  for (const c of containers) {
    while (stack.length && stack[stack.length - 1].endTok < c.startTok) stack.pop();
    c.top = stack.length === 0;
    stack.push(c);
  }

  const specs = [...containers, ...floats].sort((x, y) => x.start - y.start || y.end - x.end);
  const specByStart = new Map<number, Spec>();
  for (const s of specs) if (!specByStart.has(s.startTok)) specByStart.set(s.startTok, s);

  const fns: FnRange[] = [];
  for (const f of model.functions) {
    if (!f.bodyRange) continue;
    fns.push({ name: f.name, start: model.lines.offsetAt(f.bodyRange.start), end: model.lines.offsetAt(f.bodyRange.end) });
  }

  const byLine = new Map<number, Spec[]>();
  for (const s of specs) {
    const line = model.lines.lineAt(s.start);
    const l = byLine.get(line);
    if (l) l.push(s);
    else byLine.set(line, [s]);
  }
  return { model, seq, dirs, match, specs, specByStart, fns, byLine };
}

export function functionAt(a: Analysis, offset: number): string | undefined {
  let best: FnRange | undefined;
  for (const f of a.fns) if (f.start <= offset && offset <= f.end && (!best || f.start > best.start)) best = f;
  return best?.name;
}

/** Index of the token containing `offset` (end inclusive), preferring the one that starts there; -1 when none. */
export function tokenAt(seq: STok[], offset: number): number {
  let lo = 0;
  let hi = seq.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (seq[mid].start <= offset) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return -1;
  // `a|b` boundary: prefer the token starting at offset (found), else the one ending there.
  if (seq[found].end >= offset) return found;
  return -1;
}

// ---------------------------------------------------------------- statements

const STOP = new Set([';', '{', '}']);

/** First token index of the statement containing token `i`. */
export function stmtStart(seq: STok[], match: Int32Array, i: number): number {
  let depth = 0;
  let k = i;
  for (; k > 0; k--) {
    const prev = seq[k - 1];
    if (prev.region !== seq[i].region) break;
    if (prev.kind === 'punct') {
      if (prev.text === ')' || prev.text === ']') depth++;
      else if (prev.text === '(' || prev.text === '[') {
        if (depth > 0) depth--;
      } else if (STOP.has(prev.text) && (depth === 0 || prev.text !== ';')) break;
    }
  }
  void match;
  return k;
}

/** Exclusive end token index of the statement containing token `i`. */
export function stmtEnd(seq: STok[], i: number): number {
  let depth = 0;
  let k = i;
  for (; k < seq.length; k++) {
    const t = seq[k];
    if (t.region !== seq[i].region) break;
    if (t.kind === 'punct') {
      if (t.text === '(' || t.text === '[') depth++;
      else if (t.text === ')' || t.text === ']') {
        if (depth > 0) depth--;
      } else if (STOP.has(t.text) && (depth === 0 || t.text !== ';')) break;
    }
  }
  return k;
}

/** Top-level, non-integer specs inside token range [from, to). */
export function statementChildren(a: Analysis, from: number, to: number): Spec[] {
  const out: Spec[] = [];
  for (const s of a.specs) {
    if (s.startTok < from) continue;
    if (s.startTok >= to) break;
    if (!s.top || s.integer || s.endTok >= to) continue;
    out.push(s);
  }
  return out;
}

/** All statements with at least two multi-eligible targets (cached per analysis). */
const groupCache = new WeakMap<Analysis, MultiGroup[]>();
export function multiGroups(a: Analysis): MultiGroup[] {
  let g = groupCache.get(a);
  if (g) return g;
  g = [];
  const byStmt = new Map<number, MultiGroup>();
  for (const s of a.specs) {
    if (!s.top || s.integer) continue;
    const from = stmtStart(a.seq, a.match, s.startTok);
    let grp = byStmt.get(from);
    if (!grp) {
      grp = { from, to: stmtEnd(a.seq, s.startTok), children: [] };
      byStmt.set(from, grp);
    }
    if (s.endTok < grp.to) grp.children.push(s);
  }
  for (const grp of byStmt.values()) if (grp.children.length >= 2) g.push(grp);
  g.sort((x, y) => x.from - y.from);
  groupCache.set(a, g);
  return g;
}
