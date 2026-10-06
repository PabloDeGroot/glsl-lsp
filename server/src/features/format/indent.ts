// Indentation: walks the tokens line by line with a small state machine
// (bracket stack, current statement, pending body of an un-braced
// if/for/while/else/do, switch case labels) and gives every line its target
// indentation width.
//
// - Block lines get `level * tabSize`, exactly.
// - Continuation lines (inside an open `(`/`[`/initializer list, or after a
//   line that cannot end a statement) get at least one level more than their
//   statement. Deeper hand alignment is kept: the line moves by the same
//   amount as its statement's first line, so `foo(a,\n    b)` aligned to
//   the parenthesis stays aligned.
// - Preprocessor conditionals: every #elif/#else branch starts from the state
//   at its #if, and #endif continues with the state at the end of the first
//   branch, so branches that each open a brace (LYGIA does this) keep the
//   depth right.

import type { Token } from '../../core/lexer';
import { isCodeToken, isCommentToken, isFalseCondition, type Analysis } from './analyze';
import { leadingWhitespace, visualWidth } from './lines';
import type { FormatOptions } from './options';

interface Entry {
  /** '{', '(' or '['. */
  kind: string;
  /** A block brace (not an initializer list or a parenthesis). */
  block: boolean;
  /** Level of the statement that opened it; its content is one deeper. */
  openLevel: number;
  isSwitch: boolean;
  /** A `case`/`default` label was seen: statements are one level deeper. */
  inCase: boolean;
}

interface State {
  stack: Entry[];
  /** A statement has started and not ended. */
  stmtOpen: boolean;
  stmtLevel: number;
  stmtFirst: string;
  /** Line of the statement's first token. */
  anchorLine: number;
  /** Level for the body of an un-braced if/for/while/else/do header that just ended. */
  pending: number | null;
  /** First line of that header. */
  pendingAnchor: number;
  /** if/for/while/switch waiting for the `)` that ends its header. */
  headerKw: string | null;
  headerDepth: number;
  /** The next block brace is a switch body. */
  switchPending: boolean;
  prev: Token | undefined;
}

function cloneState(s: State): State {
  return { ...s, stack: s.stack.map((e) => ({ ...e })) };
}

export interface IndentResult {
  /** Target indentation width for lines the formatter re-indents (code, comment and blank lines), else undefined. */
  width: (number | undefined)[];
  /** Brackets balance (no unclosed or unmatched `{ ( [`): indentation is trustworthy. */
  balanced: boolean;
  /** Original column of each line's trailing comment (or of a comment-only line continuing one). */
  commentCol: (number | undefined)[];
}

const CONTROL_HEADERS = new Set(['if', 'for', 'while', 'switch']);
const NOT_EXPECTING = new Set([')', ']', '}', ';', '{', '++', '--']);
const NOT_CONTINUING = new Set(['{', '}', '(']);

function sameBrackets(a: State, b: State): boolean {
  return a.stack.length === b.stack.length && a.stack.every((e, i) => e.kind === b.stack[i].kind && e.block === b.stack[i].block);
}

function directiveName(text: string): string {
  return /^#\s*([A-Za-z_]\w*)/.exec(text)?.[1] ?? '';
}

export function computeIndentation(an: Analysis, opts: FormatOptions): IndentResult {
  const { tokens, lines, text } = an;
  const U = opts.unitWidth;
  const n = lines.length;
  const width: (number | undefined)[] = new Array(n).fill(undefined);
  /** New width minus original width of every line (0 for lines left alone). */
  const delta: number[] = new Array(n).fill(0);
  let unmatched = false;
  /** Original column of a trailing comment (after code) on each line, for comment lines continuing it. */
  const trailingCol: (number | undefined)[] = new Array(n).fill(undefined);
  /** Indentation change of the last code line, applied to deeper comment lines. */
  let lastCodeDelta = 0;

  let st: State = {
    stack: [],
    stmtOpen: false,
    stmtLevel: 0,
    stmtFirst: '',
    anchorLine: 0,
    pending: null,
    pendingAnchor: 0,
    headerKw: null,
    headerDepth: 0,
    switchPending: false,
    prev: undefined,
  };
  /**
   * Open conditionals: the state at `#if`, the state at the end of the first
   * compiled branch, whether an `#elif`/`#else` was seen, whether the current
   * branch is never compiled (`#if 0`), and `unmatched` at `#if`.
   */
  const conds: { entry: State; firstEnd: State | null; sawElse: boolean; opaque: boolean; unmatched: boolean }[] = [];

  const innermostBlock = (s: State): number => {
    for (let i = s.stack.length - 1; i >= 0; i--) if (s.stack[i].block) return i;
    return -1;
  };
  const contentLevel = (s: State): number => {
    const ib = innermostBlock(s);
    if (ib < 0) return 0;
    const e = s.stack[ib];
    return e.openLevel + 1 + (e.isSwitch && e.inCase ? 1 : 0);
  };
  const expectsMore = (p: Token | undefined): boolean =>
    !!p && ((p.kind === 'punct' && !NOT_EXPECTING.has(p.text)) || (p.kind === 'ident' && p.text === 'return'));

  /** Level/width of line `l` given the state at its start. `fi` = index of its first code token, or -1. */
  const lineLevel = (l: number, fi: number, origWidth: number): { width: number; logical: number; reset: boolean } => {
    const exact = (level: number, reset = false) => ({ width: Math.max(0, level) * U, logical: Math.max(0, level), reset });
    const f = fi >= 0 ? tokens[fi] : undefined;
    const ib = innermostBlock(st);
    const top = st.stack[st.stack.length - 1];
    if (f?.text === '}' && !(top && !top.block && top.kind === '{')) return exact(ib >= 0 ? st.stack[ib].openLevel : 0);
    if (st.stmtOpen) {
      if (f && f.text === '{' && an.blockBrace.has(fi)) return exact(st.stmtLevel);
      const parens = st.stack.length - 1 - ib;
      if (parens > 0 || expectsMore(st.prev) || (f && f.kind === 'punct' && !NOT_CONTINUING.has(f.text))) {
        let remaining = parens;
        let closed = false;
        const { hi } = an.lineTokens[l];
        for (let i = fi; i >= 0 && i < hi && remaining > 0; i++) {
          const t = tokens[i];
          if (!isCodeToken(t)) continue;
          if (t.text === ')' || t.text === ']' || (t.text === '}' && !an.blockBrace.has(i))) {
            remaining--;
            closed = true;
          } else break;
        }
        const min = closed && remaining === 0 ? st.stmtLevel : st.stmtLevel + 1;
        return { width: Math.max(origWidth + delta[st.anchorLine], min * U), logical: min, reset: false };
      }
      if (!f) return exact(contentLevel(st));
      // `FOO(x)` without `;` (a macro), or a return type on its own line at file scope: a new statement.
      // Inside a block, a type on its own line followed by `a = 1, b = 2;` continues.
      if (ib >= 0 && st.prev && st.prev.text !== ')' && st.prev.text !== ']') {
        return { width: Math.max(origWidth + delta[st.anchorLine], (st.stmtLevel + 1) * U), logical: st.stmtLevel + 1, reset: false };
      }
      return exact(contentLevel(st), true);
    }
    if (st.pending !== null) {
      // Body of an un-braced header: at least the header's level, deeper indentation kept
      // (so a stack of `for (...)` lines over one braced body stays flat).
      if (f && f.text === '{' && an.blockBrace.has(fi)) return exact(st.pending - 1);
      if (opts.mode === 'opinionated') return exact(st.pending);
      const w = Math.max(origWidth + delta[st.pendingAnchor], (st.pending - 1) * U);
      return { width: w, logical: Math.floor(w / U), reset: false };
    }
    if (f && (f.text === 'case' || f.text === 'default') && ib >= 0 && st.stack[ib].isSwitch) return exact(st.stack[ib].openLevel + 1);
    return exact(contentLevel(st));
  };

  const closeStatement = () => {
    st.stmtOpen = false;
    st.pending = null;
    st.headerKw = null;
  };

  const handleCode = (t: Token, i: number, line: number, logical: number) => {
    const text = t.text;
    if (text === '{' && an.blockBrace.has(i)) {
      const openLevel = st.pending !== null ? st.pending - 1 : st.stmtOpen ? st.stmtLevel : logical;
      st.stack.push({ kind: '{', block: true, openLevel, isSwitch: st.switchPending, inCase: false });
      st.switchPending = false;
      closeStatement();
      st.prev = t;
      return;
    }
    if (!st.stmtOpen) {
      st.stmtOpen = true;
      st.stmtLevel = logical;
      st.stmtFirst = text;
      st.anchorLine = line;
      st.pending = null;
      st.headerKw = null;
      if (t.kind === 'ident' && CONTROL_HEADERS.has(text)) {
        st.headerKw = text;
        st.headerDepth = st.stack.length;
      } else if (text === 'else' || text === 'do') {
        // Header without parentheses: the body follows.
        const level = st.stmtLevel;
        closeStatement();
        st.pending = level + 1;
        st.pendingAnchor = line;
        st.prev = t;
        return;
      }
    }
    switch (text) {
      case '(':
      case '[':
        st.stack.push({ kind: text, block: false, openLevel: st.stmtLevel, isSwitch: false, inCase: false });
        break;
      case '{':
        st.stack.push({ kind: '{', block: false, openLevel: st.stmtLevel, isSwitch: false, inCase: false });
        break;
      case ')':
      case ']': {
        const want = text === ')' ? '(' : '[';
        let k = st.stack.length - 1;
        while (k >= 0 && !st.stack[k].block && st.stack[k].kind !== want) k--;
        if (k >= 0 && !st.stack[k].block) {
          st.stack.length = k;
          if (text === ')' && st.headerKw && st.stack.length === st.headerDepth) {
            const level = st.stmtLevel;
            const kw = st.headerKw;
            const anchor = st.anchorLine;
            closeStatement();
            st.pending = level + 1;
            st.pendingAnchor = anchor;
            st.switchPending = kw === 'switch';
          }
        } else unmatched = true;
        break;
      }
      case '}': {
        const topEntry = st.stack[st.stack.length - 1];
        if (topEntry && !topEntry.block && topEntry.kind === '{') {
          st.stack.pop();
          break;
        }
        let k = st.stack.length - 1;
        while (k >= 0 && !st.stack[k].block) k--;
        if (k >= 0) {
          if (k !== st.stack.length - 1) unmatched = true;
          st.stack.length = k;
        } else unmatched = true;
        closeStatement();
        st.switchPending = false;
        break;
      }
      case ';': {
        const ib = innermostBlock(st);
        if (st.stack.length - 1 - ib === 0) closeStatement();
        break;
      }
      case ':': {
        if (an.ternaryColon.has(i)) break;
        const ib = innermostBlock(st);
        if ((st.stmtFirst === 'case' || st.stmtFirst === 'default') && st.stack.length - 1 - ib === 0) {
          if (ib >= 0 && st.stack[ib].isSwitch) st.stack[ib].inCase = true;
          closeStatement();
        }
        break;
      }
    }
    st.prev = t;
  };

  const handleDirective = (t: Token) => {
    const name = directiveName(t.text);
    if (name === 'if' || name === 'ifdef' || name === 'ifndef') {
      conds.push({ entry: cloneState(st), firstEnd: null, sawElse: false, opaque: isFalseCondition(t.text), unmatched });
    } else if (name === 'elif' || name === 'else') {
      const frame = conds[conds.length - 1];
      if (!frame) return;
      if (!frame.firstEnd && !frame.opaque) frame.firstEnd = cloneState(st);
      frame.sawElse = true;
      frame.opaque = name === 'elif' && isFalseCondition(t.text);
      st = cloneState(frame.entry);
    } else if (name === 'endif') {
      const frame = conds.pop();
      if (!frame) return;
      if (frame.firstEnd) st = frame.firstEnd;
      else if (!frame.sawElse && !sameBrackets(st, frame.entry)) {
        // A lone branch that changes the depth (`#ifdef X` + `if (a) {`): it may not be compiled, so carry on as before it.
        st = cloneState(frame.entry);
        unmatched = frame.unmatched;
      }
    }
  };

  for (let l = 0; l < n; l++) {
    const kind = an.kind[l];
    const { lo, hi } = an.lineTokens[l];
    const origWidth = visualWidth(leadingWhitespace(lines[l].text), opts.tabSize);
    if (an.inactive[l]) continue;
    const applies = !an.off[l] && !an.continued[l];

    if (kind === 'directive') {
      if (opts.indentPreprocessor && applies && tokens[lo].endLine === l) {
        const name = directiveName(tokens[lo].text);
        const frame = conds[conds.length - 1];
        const level = (name === 'elif' || name === 'else' || name === 'endif') && frame ? contentLevel(frame.entry) : contentLevel(st);
        width[l] = level * U;
        delta[l] = width[l]! - origWidth;
      }
      for (let i = lo; i < hi; i++) if (tokens[i].kind === 'directive') handleDirective(tokens[i]);
      continue;
    }

    // First code token starting on this line (leading comments are skipped).
    let fi = -1;
    for (let i = lo; i < hi; i++) {
      if (isCodeToken(tokens[i])) {
        fi = i;
        break;
      }
      if (tokens[i].kind === 'directive') break;
    }

    let logical = contentLevel(st);
    if (kind === 'code' || kind === 'blank' || (kind === 'commentCont' && fi >= 0)) {
      const r = lineLevel(l, kind === 'commentCont' ? -1 : fi, origWidth);
      logical = r.logical;
      if (kind === 'code' || kind === 'blank') {
        let w = r.width;
        if (kind === 'code' && fi < 0) {
          // Comment-only line: one continuing an aligned trailing comment keeps that (absolute) column;
          // conservative mode also keeps comments indented deeper than the code (commented-out code).
          if (trailingCol[l - 1] === origWidth) {
            w = origWidth;
            trailingCol[l] = origWidth;
          } else if (opts.mode !== 'opinionated') w = Math.max(w, origWidth + lastCodeDelta);
        }
        if (applies) {
          width[l] = w;
          if (kind === 'code') delta[l] = w - origWidth;
          if (kind === 'code' && fi >= 0) lastCodeDelta = delta[l];
        }
        if (r.reset && fi >= 0) closeStatement();
      }
      if (kind === 'code' && fi >= 0 && hi - lo > 1 && isCommentToken(tokens[hi - 1]) && tokens[hi - 1].endLine === l) {
        trailingCol[l] = visualWidth(text.slice(lines[l].start, tokens[hi - 1].start), opts.tabSize);
      }
    }
    for (let i = lo; i < hi; i++) {
      const t = tokens[i];
      if (t.kind === 'directive') handleDirective(t);
      else if (isCodeToken(t)) handleCode(t, i, l, logical);
    }
  }

  return { width, balanced: !unmatched && st.stack.length === 0, commentCol: trailingCol };
}
