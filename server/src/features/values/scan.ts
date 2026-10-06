// Builds the significant-token stream of a file: comments and non-value
// directives dropped, the numeric parts of `#define` bodies and `#iUniform`
// defaults spliced in (with a distinct `region` so statements never cross
// them). Also pairs brackets and flags number tokens in contexts where a
// literal must not be offered (array subscripts, layout(...), int in for(...)).

import { lex, type FileModel } from '../../core';
import type { DirInfo, STok } from './types';

export interface Scan {
  seq: STok[];
  dirs: DirInfo[];
  match: Int32Array;
  /** Number tokens that sit in an excluded context. */
  excluded: Set<number>;
}

const INT_RE = /^\d+$/;

function parseBound(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const t = s.trim().replace(/[fF]$/, '');
  if (t === '') return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

export function scanTokens(model: FileModel): Scan {
  const seq: STok[] = [];
  const dirs: DirInfo[] = [];
  const dirByTok = new Map<number, (typeof model.directives)[number]>();
  for (const d of model.directives) dirByTok.set(d.tokenIndex, d);

  const pushLexed = (text: string, base: number, region: number) => {
    const baseLine = model.lines.lineAt(base);
    for (const t of lex(text, { baseOffset: base, baseLine, directives: false })) {
      if (t.kind === 'lineComment' || t.kind === 'blockComment') continue;
      seq.push({ ...t, region });
    }
  };

  for (let ti = 0; ti < model.tokens.length; ti++) {
    const tok = model.tokens[ti];
    if (tok.kind === 'lineComment' || tok.kind === 'blockComment') continue;
    if (tok.kind !== 'directive') {
      seq.push({ ...tok, region: -1 });
      continue;
    }
    const d = dirByTok.get(ti);
    if (!d) continue;
    const text = tok.text;
    if (d.kind === 'define') {
      const m = /^#\s*define\s+([A-Za-z_]\w*)(\([^)]*\))?/.exec(text);
      if (!m) continue;
      dirs.push({ kind: 'define', name: m[1], start: d.start, end: d.end, functionLike: m[2] !== undefined });
      pushLexed(text.slice(m[0].length), tok.start + m[0].length, dirs.length - 1);
    } else if (d.kind === 'iUniform') {
      const m = /^#\s*iUniform\s+(\w+)\s+([A-Za-z_]\w*)\s*(=\s*)?/.exec(text);
      if (!m) continue;
      const info: DirInfo = { kind: 'iUniform', name: m[2], declaredType: m[1], start: d.start, end: d.end, functionLike: false };
      const rest = text.slice(m[0].length);
      const range = /\bin\s*\{\s*([^,}]*)\s*,\s*([^}]*)\}/.exec(text);
      if (range) {
        info.min = parseBound(range[1]);
        info.max = parseBound(range[2]);
      }
      const step = /\bstep\s+(\S+)/.exec(text);
      if (step) info.step = parseBound(step[1]);
      dirs.push(info);
      if (m[3]) {
        const cut = rest.search(/\s+in\s*\{|\s+step\b/);
        pushLexed(cut >= 0 ? rest.slice(0, cut) : rest, tok.start + m[0].length, dirs.length - 1);
      }
    }
  }

  // Bracket pairing and excluded contexts.
  const match = new Int32Array(seq.length).fill(-1);
  const excluded = new Set<number>();
  type Frame = { idx: number; ch: string; kind: 'layout' | 'for' | 'bracket' | 'other' };
  let stack: Frame[] = [];
  let region = -2;
  for (let i = 0; i < seq.length; i++) {
    const t = seq[i];
    if (t.region !== region) {
      region = t.region;
      stack = [];
    }
    if (t.kind === 'punct') {
      const c = t.text;
      if (c === '(') {
        const p = i > 0 && seq[i - 1].region === t.region ? seq[i - 1] : undefined;
        const kind = p?.kind === 'ident' && p.text === 'layout' ? 'layout' : p?.kind === 'ident' && p.text === 'for' ? 'for' : 'other';
        stack.push({ idx: i, ch: '(', kind });
      } else if (c === '[') stack.push({ idx: i, ch: '[', kind: 'bracket' });
      else if (c === ')' || c === ']') {
        const open = c === ')' ? '(' : '[';
        let k = stack.length - 1;
        while (k >= 0 && stack[k].ch !== open) k--;
        if (k >= 0) {
          match[stack[k].idx] = i;
          match[i] = stack[k].idx;
          stack.length = k;
        }
      } else if (c === '{' || c === '}') stack = [];
    } else if (t.kind === 'number') {
      let bad = false;
      for (const f of stack) {
        if (f.kind === 'bracket' || f.kind === 'layout') bad = true;
        else if (f.kind === 'for' && INT_RE.test(t.text)) bad = true;
      }
      if (bad) excluded.add(i);
    }
  }
  return { seq, dirs, match, excluded };
}
