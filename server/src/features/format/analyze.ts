// One lexing pass over a document, annotated with what every formatter stage
// needs: the tokens of each line, what kind of line it is, which lines are
// protected (`// glsl-format off` regions, backslash continuations), which
// `{` open blocks rather than initializer lists, and which `+`/`-`/`:`
// tokens are unary / ternary.

import { lex, type Token } from '../../core/lexer';
import { splitLines, type SourceLine } from './lines';

export type LineKind =
  /** Only whitespace. */
  | 'blank'
  /** First token is code or a comment that starts on this line. */
  | 'code'
  /** A preprocessor line (its first line when continued with `\`). */
  | 'directive'
  /** Starts inside a block comment opened on an earlier line. */
  | 'commentCont'
  /** Continuation line of a `\`-continued directive. */
  | 'directiveCont'
  /** Something the lexer does not see (a lone `\`): left alone. */
  | 'raw';

export interface Analysis {
  text: string;
  lines: SourceLine[];
  tokens: Token[];
  /** Tokens starting on each line: indices [lo, hi). */
  lineTokens: { lo: number; hi: number }[];
  kind: LineKind[];
  /** Inside a `// glsl-format off` ... `// glsl-format on` region (marker lines included). */
  off: boolean[];
  /** Code line ending in a backslash continuation, or a line it continues: left exactly as is. */
  continued: boolean[];
  /**
   * Not code: inside an `#if 0` / `#if false` branch, or a line continuing a
   * `//` comment that ends in a backslash. Left as is (also marked `off`) and
   * ignored for indentation.
   */
  inactive: boolean[];
  /** For commentCont/directiveCont lines: the index of the token that covers the line start. */
  coveredBy: number[];
  /** Indices of `{` tokens opening a block (function, struct, statement), and of the `}` closing them; the others belong to initializer lists. */
  blockBrace: Set<number>;
  /** Previous code token (no comments, no directives) of every token, or -1. */
  prevCode: Int32Array;
  /** `+` / `-` tokens used as unary operators. */
  unary: Set<number>;
  /** `:` tokens of a `?:` conditional (the others end `case` / `default` labels). */
  ternaryColon: Set<number>;
}

export function isCommentToken(t: Token): boolean {
  return t.kind === 'lineComment' || t.kind === 'blockComment';
}

export function isCodeToken(t: Token): boolean {
  return t.kind !== 'lineComment' && t.kind !== 'blockComment' && t.kind !== 'directive';
}

const FORMAT_MARKER = /^(?:\/\/|\/\*)\s*glsl-format\s*:?\s*(off|on)\s*(?:\*\/)?$/;

/** Identifiers after which `+` / `-` are unary (they do not end an operand). */
const NON_OPERAND_WORDS = new Set(['return', 'case', 'else', 'do', 'if', 'while', 'for', 'switch']);

/** True when a token ends an operand, so a following `+` / `-` is binary. */
export function endsOperand(t: Token | undefined): boolean {
  if (!t) return false;
  if (t.kind === 'number') return true;
  if (t.kind === 'ident') return !NON_OPERAND_WORDS.has(t.text);
  return t.text === ')' || t.text === ']' || t.text === '++' || t.text === '--';
}

/** Tokens before which a `{` opens an initializer list. */
const INIT_BEFORE = new Set(['=', ',', '(', '[', 'return']);

export function analyze(text: string): Analysis {
  const lines = splitLines(text);
  const tokens = lex(text);
  const n = lines.length;
  const lineTokens = Array.from({ length: n }, () => ({ lo: 0, hi: 0 }));
  const kind: LineKind[] = new Array(n).fill('blank');
  const off: boolean[] = new Array(n).fill(false);
  const continued: boolean[] = new Array(n).fill(false);
  const coveredBy: number[] = new Array(n).fill(-1);
  const inactive: boolean[] = new Array(n).fill(false);

  // Tokens per line (tokens are sorted by offset, so lines are monotonic).
  let ti = 0;
  for (let l = 0; l < n; l++) {
    while (ti < tokens.length && tokens[ti].line < l) ti++;
    const lo = ti;
    let hi = ti;
    while (hi < tokens.length && tokens[hi].line === l) hi++;
    lineTokens[l] = { lo, hi };
  }

  // Lines covered by multi-line tokens.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    for (let l = t.line + 1; l <= t.endLine && l < n; l++) {
      coveredBy[l] = i;
      kind[l] = t.kind === 'directive' ? 'directiveCont' : 'commentCont';
    }
  }
  for (let l = 0; l < n; l++) {
    if (coveredBy[l] >= 0) continue;
    const { lo, hi } = lineTokens[l];
    if (hi > lo) kind[l] = tokens[lo].kind === 'directive' ? 'directive' : 'code';
    else kind[l] = lines[l].text.trim() === '' ? 'blank' : 'raw';
    if (kind[l] === 'code' && /\\\s*$/.test(lines[l].text)) continued[l] = true;
  }
  // A backslash at the end of a line comment continues the comment (GLSL ES 3.0); after code it
  // continues the line. Either way the following lines of the group are left alone.
  for (let l = 0; l + 1 < n; l++) {
    if (!/\\\s*$/.test(lines[l].text) || (kind[l] !== 'code' && !inactive[l] && !continued[l])) continue;
    const { lo, hi } = lineTokens[l];
    const last = tokens[hi - 1];
    const inComment = inactive[l] || (hi > lo && last.kind === 'lineComment' && last.endLine === l);
    if (inComment) inactive[l + 1] = true;
    else if (kind[l + 1] !== 'directiveCont' && kind[l + 1] !== 'commentCont') continued[l + 1] = true;
  }

  // `#if 0` / `#if false` branches (and everything nested in them) are not code.
  const conds: { parentOpaque: boolean; opaque: boolean }[] = [];
  for (let l = 0; l < n; l++) {
    const opaqueNow = conds.length > 0 && conds[conds.length - 1].opaque;
    if (kind[l] !== 'directive') {
      if (opaqueNow && kind[l] !== 'directiveCont') inactive[l] = true;
      continue;
    }
    const t = tokens[lineTokens[l].lo];
    const name = /^#\s*([A-Za-z_]\w*)/.exec(t.text)?.[1] ?? '';
    if (name === 'if' || name === 'ifdef' || name === 'ifndef') {
      if (opaqueNow) inactive[l] = true;
      conds.push({ parentOpaque: opaqueNow, opaque: opaqueNow || (name === 'if' && isFalseCondition(t.text)) });
    } else if (name === 'elif' || name === 'else') {
      const c = conds[conds.length - 1];
      if (c?.parentOpaque) inactive[l] = true;
      if (c) c.opaque = c.parentOpaque || (name === 'elif' && isFalseCondition(t.text));
    } else if (name === 'endif') {
      const c = conds.pop();
      if (c?.parentOpaque) inactive[l] = true;
    } else if (opaqueNow) inactive[l] = true;
  }
  for (let l = 0; l < n; l++) if (inactive[l]) continued[l] = false;

  // Format-off regions.
  let offFrom = -1;
  for (const t of tokens) {
    if (!isCommentToken(t)) continue;
    const m = FORMAT_MARKER.exec(t.text.trim());
    if (!m) continue;
    if (m[1] === 'off' && offFrom < 0) offFrom = t.line;
    else if (m[1] === 'on' && offFrom >= 0) {
      for (let l = offFrom; l <= t.endLine && l < n; l++) off[l] = true;
      offFrom = -1;
    }
  }
  if (offFrom >= 0) for (let l = offFrom; l < n; l++) off[l] = true;
  for (let l = 0; l < n; l++) if (inactive[l]) off[l] = true;

  // Token annotations.
  const prevCode = new Int32Array(tokens.length).fill(-1);
  const blockBrace = new Set<number>();
  const unary = new Set<number>();
  const ternaryColon = new Set<number>();
  let last = -1;
  let ternary = 0;
  const open: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!isCodeToken(t) || inactive[t.line]) continue;
    prevCode[i] = last;
    const p = last >= 0 ? tokens[last] : undefined;
    switch (t.text) {
      case '{': {
        const init = !!p && (INIT_BEFORE.has(p.text) || (p.text === '{' && !blockBrace.has(last)));
        if (!init) blockBrace.add(i);
        if (!init) ternary = 0;
        open.push(i);
        break;
      }
      case '}': {
        // A `}` closing a block brace is in blockBrace too.
        const o = open.pop();
        if (o !== undefined && blockBrace.has(o)) blockBrace.add(i);
        ternary = 0;
        break;
      }
      case ';':
        ternary = 0;
        break;
      case '?':
        ternary++;
        break;
      case ':':
        if (ternary > 0) {
          ternary--;
          ternaryColon.add(i);
        }
        break;
      case '+':
      case '-':
        if (!endsOperand(p)) unary.add(i);
        break;
    }
    last = i;
  }

  return { text, lines, tokens, lineTokens, kind, off, continued, inactive, coveredBy, blockBrace, prevCode, unary, ternaryColon };
}

/** `#if 0`, `#if false`, `#elif (0)`: a branch that is never compiled. */
export function isFalseCondition(directive: string): boolean {
  return /^#\s*(?:el)?if\s*\(?\s*(?:0+|false)\s*\)?\s*(?:\/\*.*\*\/\s*)?$/.test(directive);
}

/** Normalized token sequence for the token-preservation check: comment and directive whitespace runs collapse. */
export function tokenSignature(text: string): string[] {
  return lex(text).map((t) => (t.kind === 'lineComment' || t.kind === 'blockComment' || t.kind === 'directive' ? `${t.kind}:${t.text.split(/\s+/).filter(Boolean).join(' ')}` : `${t.kind}:${t.text}`));
}
