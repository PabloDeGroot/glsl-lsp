// Cursor resolution: which value target is "at" a position.
//
// Priority (docs/VALUES.md section 8):
//   1 palette containing the cursor, 2 innermost vec constructor, 3 number
//   literal touching the cursor, 4 identifier resolving to a variable /
//   uniform / #define whose initializer is exactly one target, 5 the
//   statement (multi when it has >= 2 targets), 6 nearest target on the line.

import { isKeyword, resolveSymbolAt, type MacroSymbol, type Position, type VariableSymbol } from '../../core';
import type { ValueTarget } from '../../../../shared/valuesProtocol';
import { analyze, statementChildren, stmtEnd, stmtStart, tokenAt } from './analysis';
import { buildMulti, buildTarget } from './build';
import type { Analysis, Spec, ValuesEnv } from './types';

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=']);

function inComment(a: Analysis, o: number): boolean {
  const toks = a.model.tokens;
  let lo = 0;
  let hi = toks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = toks[mid];
    if (o < t.start) hi = mid - 1;
    else if (o > t.end) lo = mid + 1;
    else {
      if (t.kind === 'lineComment') return o > t.start;
      if (t.kind === 'blockComment') return o > t.start && o < t.end;
      return false;
    }
  }
  return false;
}

export function cursorTarget(env: ValuesEnv, a: Analysis, pos: Position): ValueTarget | null {
  const model = a.model;
  const o = model.lines.offsetAt(pos);
  if (inComment(a, o)) return null;

  const smallest = (pred: (s: Spec) => boolean): Spec | undefined => {
    let best: Spec | undefined;
    for (const s of a.specs) {
      if (s.start > o) break;
      if (pred(s) && (!best || s.end - s.start < best.end - best.start)) best = s;
    }
    return best;
  };

  // 1 palette
  const pal = smallest((s) => s.kind === 'palette' && o <= s.end);
  if (pal) return buildTarget(env, a, pal);
  // 2 vec, 3 literal. A literal under the cursor inside a locked vector
  // argument (`vec2(5.2, 1.3 - t * 0.|15)`) is not one of the vector's slots:
  // the literal itself is what the user points at.
  const vec = smallest((s) => !!s.vec && o <= s.end);
  const lit = smallest((s) => !!s.lit && o < s.end) ?? smallest((s) => !!s.lit && o === s.end);
  if (vec && lit && lit.start >= vec.start && lit.end <= vec.end && o >= lit.start) return buildTarget(env, a, lit);
  if (vec) return buildTarget(env, a, vec);
  if (lit) return buildTarget(env, a, lit);
  // 4 identifier
  const id = identifierTarget(env, a, pos, o);
  if (id) return id;

  // 5 statement
  const tok = nearTokenOnLine(a, o, pos.line);
  if (tok >= 0) {
    const s = stmtStart(a.seq, a.match, tok);
    const e = stmtEnd(a.seq, tok);
    if (e > s) {
      const firstLine = model.lines.lineAt(a.seq[s].start);
      const lastLine = model.lines.lineAt(a.seq[e - 1].end);
      if (firstLine <= pos.line && pos.line <= lastLine) {
        const kids = statementChildren(a, s, e);
        if (kids.length >= 2) return buildMulti(env, a, { from: s, to: e, children: kids }, o);
        if (kids.length === 1) return buildTarget(env, a, kids[0]);
      }
    }
  }

  // 6 nearest target on the line
  let best: Spec | undefined;
  let bestD = Infinity;
  for (const s of a.byLine.get(pos.line) ?? []) {
    if (s.integer) continue;
    const d = o < s.start ? s.start - o : o > s.end ? o - s.end : 0;
    if (d < bestD || (d === bestD && best && s.end - s.start > best.end - best.start)) {
      best = s;
      bestD = d;
    }
  }
  return best ? buildTarget(env, a, best) : null;
}

/** Token containing the cursor, else the next token on the same line, else the previous one. */
function nearTokenOnLine(a: Analysis, o: number, line: number): number {
  const seq = a.seq;
  const i = tokenAt(seq, o);
  if (i >= 0) return i;
  let lo = 0;
  let hi = seq.length - 1;
  let next = seq.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (seq[mid].start > o) {
      next = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  if (next < seq.length && seq[next].line === line) return next;
  if (next - 1 >= 0 && seq[next - 1].endLine === line) return next - 1;
  return -1;
}

function identifierTarget(env: ValuesEnv, a: Analysis, pos: Position, o: number): ValueTarget | undefined {
  const seq = a.seq;
  let ti = tokenAt(seq, o);
  if (ti > 0 && seq[ti].kind !== 'ident' && seq[ti - 1].kind === 'ident' && seq[ti - 1].end === o) ti--;
  const t = seq[ti];
  if (!t || t.kind !== 'ident' || isKeyword(t.text)) return undefined;
  // `col = ...`: the identifier is being assigned, the statement's own value is what the user means.
  let n = ti + 1;
  if (seq[n]?.text === '.' && seq[n + 1]?.kind === 'ident') n += 2;
  if (seq[n] && seq[n].kind === 'punct' && ASSIGN_OPS.has(seq[n].text) && seq[n].region === t.region) {
    // ...unless it is the declaration itself (`float r = 0.25;` points at its own initializer anyway).
    return undefined;
  }
  const res = resolveSymbolAt(env.workspace, a.model.uri, { line: t.line, character: Math.max(0, o - a.model.lines.lineStarts[t.line]) });
  void pos;
  if (!res || res.kind !== 'symbol') return undefined;
  const sym = res.primary;
  if (sym.kind !== 'variable' && sym.kind !== 'macro') return undefined;
  const model2 = sym.uri === a.model.uri ? a.model : env.getModel(sym.uri);
  if (!model2) return undefined;
  const a2 = sym.uri === a.model.uri ? a : analyze(model2);
  const spec = initializerSpec(a2, sym);
  return spec ? buildTarget(env, a2, spec) : undefined;
}

function initializerSpec(a: Analysis, sym: VariableSymbol | MacroSymbol): Spec | undefined {
  const model = a.model;
  if (sym.kind === 'macro' || sym.iUniform) {
    if (sym.kind === 'macro' && sym.params) return undefined;
    const dirStart = model.lines.offsetAt(sym.range.start);
    const idx = a.dirs.findIndex((d) => d.name === sym.name && d.start === dirStart);
    if (idx < 0) return undefined;
    const inDir = a.specs.filter((s) => s.top && a.seq[s.startTok].region === idx);
    if (inDir.length !== 1) return undefined;
    const s = inDir[0];
    // The target must be the whole value.
    if (a.seq[s.startTok - 1]?.region === idx || a.seq[s.endTok + 1]?.region === idx) return undefined;
    return s;
  }
  const ir = sym.initializerRange;
  if (!ir) return undefined;
  let s0 = model.lines.offsetAt(ir.start);
  let e0 = model.lines.offsetAt(ir.end);
  while (s0 < e0 && /\s/.test(model.text[s0])) s0++;
  while (e0 > s0 && /\s/.test(model.text[e0 - 1])) e0--;
  return a.specs.find((s) => s.top && s.start === s0 && s.end === e0);
}
