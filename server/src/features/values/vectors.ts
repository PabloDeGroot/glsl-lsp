// vec2/vec3/vec4 (and color3/color4) constructors with literal arguments.

import type { Lit, Spec, STok, VecInfo } from './types';

const DIM: Record<string, 2 | 3 | 4> = { vec2: 2, vec3: 3, vec4: 4, color3: 3, color4: 4 };

/** Splits the tokens between `open` and `close` at top-level commas. */
export function splitArgTokens(seq: STok[], match: Int32Array, open: number, close: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let from = open + 1;
  let i = open + 1;
  while (i < close) {
    const t = seq[i];
    if (t.kind === 'punct') {
      if ((t.text === '(' || t.text === '[') && match[i] > i && match[i] < close) {
        i = match[i] + 1;
        continue;
      }
      if (t.text === ',') {
        out.push({ from, to: i });
        from = i + 1;
      }
    }
    i++;
  }
  if (close > open + 1 || out.length > 0) out.push({ from, to: close });
  return out;
}

export function findVectors(seq: STok[], match: Int32Array, lits: Map<number, Lit>): Spec[] {
  const out: Spec[] = [];
  for (let i = 0; i + 1 < seq.length; i++) {
    const t = seq[i];
    if (t.kind !== 'ident') continue;
    const dim = DIM[t.text];
    if (!dim) continue;
    const open = i + 1;
    if (seq[open].text !== '(' || seq[open].region !== t.region) continue;
    const close = match[open];
    if (close < 0) continue;
    if (i > 0 && seq[i - 1].text === '.' && seq[i - 1].end === t.start) continue;
    const parts = splitArgTokens(seq, match, open, close);
    const args = parts.map((p) => {
      const lit = p.to - p.from >= 1 ? lits.get(p.to - 1) : undefined;
      return { ...p, lit: lit && lit.startTok === p.from ? lit : undefined };
    });
    const splat = args.length === 1;
    if (!splat && args.length !== dim) continue;
    if (!args.some((a) => a.lit)) continue;
    if (splat && !args[0].lit) continue;
    const info: VecInfo = { ctor: t.text, dim, open, close, splat, args };
    out.push({
      kind: dim === 2 ? 'vec2' : dim === 3 ? 'vec3' : 'vec4',
      startTok: i,
      endTok: close,
      start: t.start,
      end: seq[close].end,
      top: true,
      vec: info,
      integer: false,
    });
  }
  return out;
}
