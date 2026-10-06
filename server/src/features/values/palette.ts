// Inigo Quilez cosine palettes:
//   call:        palette(t, a, b, c, d)  /  any call whose last four args are vec3 literals
//   expression:  a + b * cos(6.28318 * (c * t + d)), also without c (c = 1),
//                with scalar a / b, and with a..d as `vec3 x = vec3(...)` variables

import { BASIC_TYPES, isKeyword } from '../../core';
import type { Lit, PaletteInfo, Spec, STok } from './types';
import { splitArgTokens } from './vectors';

type Quad = [Spec, Spec, Spec, Spec];

const TWO_PI = 6.28318530718;
/** 6.28 (a common hand-written 2*pi) is 0.0032 off; anything this close is meant as 2*pi. */
const PI_TOL = 0.01;
const PI_NAMES = new Set(['PI', 'M_PI', 'pi']);
const TAU_NAMES = new Set(['TAU', 'TWO_PI', 'PI2', 'TWOPI', 'M_2PI', 'tau']);

function isPlainVec3(s: Spec | undefined): s is Spec {
  return !!s && s.kind === 'vec3' && !!s.vec && s.vec.args.every((a) => !!a.lit);
}

/** A scalar `a`/`b` (`0.5 + 0.5 * cos(...)`): a splat vec3 with no constructor (the client wraps it in `vec3(...)` when the channels differ). */
function scalarSpec(seq: STok[], lit: Lit): Spec {
  return {
    kind: 'vec3',
    startTok: lit.startTok,
    endTok: lit.endTok,
    start: lit.start,
    end: lit.end,
    top: false,
    vec: { ctor: '', dim: 3, open: -1, close: -1, splat: true, args: [{ from: lit.startTok, to: lit.endTok + 1, lit }] },
    integer: false,
  };
}

/** The implicit `c = vec3(1.0)` of `a + b * cos(K * (t + d))`, placed (empty) at the start of `t`. */
function implicitSpec(seq: STok[], tok: number): Spec {
  const at = seq[tok].start;
  return { kind: 'vec3', startTok: tok, endTok: tok, start: at, end: at, top: false, implicit: true, paletteRole: 'c', integer: false };
}

function paletteSpec(seq: STok[], startTok: number, endTok: number, shape: PaletteInfo['shape'], children: Quad): Spec {
  return { kind: 'palette', startTok, endTok, start: seq[startTok].start, end: seq[endTok].end, top: true, palette: { shape, children }, integer: false };
}

export function findPalettes(seq: STok[], match: Int32Array, vecs: Spec[], lits: Map<number, Lit>): Spec[] {
  const out: Spec[] = [];
  const vecAt = new Map<number, Spec>();
  for (const v of vecs) vecAt.set(v.startTok, v);

  // ---- call shape
  for (let i = 0; i + 1 < seq.length; i++) {
    const t = seq[i];
    if (t.kind !== 'ident' || seq[i + 1].text !== '(' || seq[i + 1].region !== t.region) continue;
    if (isKeyword(t.text) || BASIC_TYPES.has(t.text) || /^(?:color[34])$/.test(t.text)) continue;
    if (i > 0 && seq[i - 1].text === '.') continue;
    const close = match[i + 1];
    if (close < 0) continue;
    const args = splitArgTokens(seq, match, i + 1, close);
    if (args.length < 4) continue;
    if (!(/pal/i.test(t.text) || args.length === 5)) continue;
    const last = args.slice(-4).map((a) => {
      const v = vecAt.get(a.from);
      return v && v.endTok === a.to - 1 ? v : undefined;
    });
    if (!last.every(isPlainVec3)) continue;
    // A function definition `vec3 palette(...)` never has vec3 literals as parameters.
    out.push(paletteSpec(seq, i, close, 'call', last as Quad));
  }

  // ---- expression shape (anchored on `* cos(`):
  //   A + B * cos(K * (C * t + D))  |  ... (t * C + D)  |  ... (t + D) (c = 1)
  // A/B/C/D: vec3 literals, or variables declared `vec3 x = vec3(<literals>)`;
  // A/B may also be scalars (`0.5 + 0.5 * cos(...)`, edited as a splat).
  const p = (j: number, text: string) => j >= 0 && j < seq.length && seq[j].text === text;
  const vecEnd = new Map<number, Spec>();
  for (const v of vecs) if (!vecEnd.has(v.endTok)) vecEnd.set(v.endTok, v);
  const role = (s: Spec | undefined, r: NonNullable<Spec['paletteRole']>) => {
    if (s && !s.paletteRole) s.paletteRole = r;
  };

  /** `vec3 name = vec3(<literals>)` nearest before token `j`; null when declared otherwise (parameter, uniform, ...). */
  const declOf = (j: number): Spec | null => {
    const name = seq[j].text;
    for (let k = j - 1; k > 0; k--) {
      const t = seq[k];
      if (t.text !== name || t.kind !== 'ident' || t.region !== seq[j].region) continue;
      if (!BASIC_TYPES.has(seq[k - 1].text)) continue;
      if (seq[k - 1].text !== 'vec3' || !p(k + 1, '=')) return null;
      const v = vecAt.get(k + 2);
      return isPlainVec3(v) && (p(v.endTok + 1, ';') || p(v.endTok + 1, ',')) ? v : null;
    }
    return null;
  };
  const isVarTok = (j: number) =>
    seq[j]?.kind === 'ident' && !isKeyword(seq[j].text) && !BASIC_TYPES.has(seq[j].text) && !p(j - 1, '.') && !p(j + 1, '(') && !p(j + 1, '.') && !p(j + 1, '[');

  type Operand = { spec: Spec | null; from: number; to: number; scalar?: boolean };
  /** Operand ending at token `e` (inclusive). */
  const operandEndingAt = (e: number, allowScalar: boolean): Operand | undefined => {
    const v = vecEnd.get(e);
    if (v) return isPlainVec3(v) ? { spec: v, from: v.startTok, to: e } : undefined;
    const lit = lits.get(e);
    if (lit) return allowScalar && !lit.integer ? { spec: scalarSpec(seq, lit), from: lit.startTok, to: e, scalar: true } : undefined;
    if (isVarTok(e)) return { spec: declOf(e), from: e, to: e };
    return undefined;
  };
  /** Operand starting at token `b`. */
  const operandStartingAt = (b: number): Operand | undefined => {
    const v = vecAt.get(b);
    if (v) return isPlainVec3(v) ? { spec: v, from: b, to: v.endTok } : undefined;
    if (isVarTok(b)) return { spec: declOf(b), from: b, to: b };
    return undefined;
  };
  const num = (x: number) => (seq[x]?.kind === 'number' ? parseFloat(seq[x].text) : NaN);
  const isPi = (x: number) => (seq[x]?.kind === 'ident' && PI_NAMES.has(seq[x].text)) || Math.abs(num(x) - Math.PI) < PI_TOL / 2;
  const isTwo = (x: number) => num(x) === 2;

  for (let i = 2; i + 1 < seq.length; i++) {
    if (seq[i].text !== 'cos' || !p(i - 1, '*') || !p(i + 1, '(')) continue;
    const cosClose = match[i + 1];
    if (cosClose < 0) continue;
    // B * cos(   and   A + B
    const B = operandEndingAt(i - 2, true);
    if (!B || !p(B.from - 1, '+')) continue;
    const A = operandEndingAt(B.from - 2, true);
    if (!A) continue;
    // The new operand forms must not be the tail of a product / member access (`x * 0.5 + ...`).
    const before = seq[A.from - 1];
    if (!vecAt.has(A.from) && before && /^(?:\*|\/|\.|-|\))$/.test(before.text)) continue;
    // K = 2*pi, written as 6.28318 / 6.2832 / 6.28 / TAU / 2.0*PI / 2.0*3.14159 / PI*2.0 ...
    const j = i + 2;
    let k = -1;
    const kt = seq[j];
    if (kt?.kind === 'number' && Math.abs(num(j) - TWO_PI) < PI_TOL) k = j + 1;
    else if (kt?.kind === 'ident' && TAU_NAMES.has(kt.text)) k = j + 1;
    else if (isTwo(j) && p(j + 1, '*') && isPi(j + 2)) k = j + 3;
    else if (isPi(j) && p(j + 1, '*') && isTwo(j + 2)) k = j + 3;
    if (k < 0 || !p(k, '*') || !p(k + 1, '(')) continue;
    const innerOpen = k + 1;
    const innerClose = match[innerOpen];
    if (innerClose < 0 || innerClose + 1 !== cosClose) continue;
    // inside: C * t + D   |   t * C + D   |   t + D
    let plus = -1;
    let star = false;
    for (let x = innerOpen + 1; x < innerClose; x++) {
      const tx = seq[x];
      if (tx.text === '(' || tx.text === '[') {
        x = match[x] > x ? match[x] : x;
        continue;
      }
      if (tx.text === '*') star = true;
      if (tx.text === '+' && x > innerOpen + 1) {
        plus = x;
        break;
      }
    }
    if (plus < 0) continue;
    const D = operandStartingAt(plus + 1);
    if (!D || D.to + 1 !== innerClose) continue;
    let C: Operand | 'implicit' | undefined;
    const first = operandStartingAt(innerOpen + 1);
    if (first?.spec && p(first.to + 1, '*') && first.to + 2 < plus) C = first;
    else {
      const tail = operandEndingAt(plus - 1, false);
      if (tail?.spec && p(tail.from - 1, '*') && tail.from - 1 > innerOpen + 1) C = tail;
      else if (!star) C = 'implicit';
      else if (first && !first.spec && p(first.to + 1, '*')) C = first; // unresolved variable: roles only
      else if (tail && !tail.spec && p(tail.from - 1, '*')) C = tail;
    }
    if (!C) continue;
    // Variables keep their palette role even when the whole palette cannot be edited here.
    role(A.spec ?? undefined, 'a');
    role(B.spec ?? undefined, 'b');
    if (C !== 'implicit') role(C.spec ?? undefined, 'c');
    role(D.spec ?? undefined, 'd');
    const c = C === 'implicit' ? implicitSpec(seq, innerOpen + 1) : C.spec;
    if (!A.spec || !B.spec || !c || !D.spec) continue;
    out.push(paletteSpec(seq, A.from, cosClose, 'expression', [A.spec, B.spec, c, D.spec]));
  }
  void lits;
  return out;
}
