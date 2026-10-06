// Number literal detection: a unary minus belongs to the literal.

import type { Lit, STok } from './types';

const FLOAT_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fF]?$/;
const INT_RE = /^\d+$/;

/** True when a `-` preceded by `prev` is a unary minus. */
function unaryContext(prev: STok | undefined, minus: STok): boolean {
  if (!prev || prev.region !== minus.region) return true;
  if (prev.kind === 'punct') return prev.text !== ')' && prev.text !== ']' && prev.text !== '++' && prev.text !== '--';
  if (prev.kind === 'ident') return prev.text === 'return' || prev.text === 'case';
  return false;
}

export function parseLiteralAt(seq: STok[], i: number): Lit | undefined {
  const t = seq[i];
  if (t.kind !== 'number') return undefined;
  if (!FLOAT_RE.test(t.text)) return undefined; // hex, uint suffix, ...
  const raw = parseFloat(t.text.replace(/[fF]$/, ''));
  if (!Number.isFinite(raw)) return undefined;
  const integer = INT_RE.test(t.text);
  const minus = i > 0 ? seq[i - 1] : undefined;
  if (minus && minus.kind === 'punct' && minus.text === '-' && minus.end === t.start && minus.region === t.region && unaryContext(seq[i - 2], minus)) {
    return { startTok: i - 1, endTok: i, start: minus.start, end: t.end, value: -raw, text: '-' + t.text, integer };
  }
  return { startTok: i, endTok: i, start: t.start, end: t.end, value: raw, text: t.text, integer };
}

/** Every literal outside excluded contexts, keyed by the token index of its number. */
export function findLiterals(seq: STok[], excluded: Set<number>): Map<number, Lit> {
  const out = new Map<number, Lit>();
  for (let i = 0; i < seq.length; i++) {
    if (seq[i].kind !== 'number' || excluded.has(i)) continue;
    const lit = parseLiteralAt(seq, i);
    if (lit) out.set(i, lit);
  }
  return out;
}
