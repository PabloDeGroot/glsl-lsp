// Rebuilds every line: indentation (indent.ts), intra-line spacing
// (spacing.ts), trailing whitespace, blank-line runs and the final newline.
// Protected lines (format-off regions, preprocessor lines, macro and
// backslash continuations) are copied, at most losing trailing whitespace.

import type { Token } from '../../core/lexer';
import { isCommentToken, type Analysis } from './analyze';
import type { IndentResult } from './indent';
import { detectEol, leadingWhitespace, makeIndent, visualWidth } from './lines';
import type { FormatOptions } from './options';
import { canJoin, conservativeGap, opinionatedGap } from './spacing';

/** Each line's new text including its line break, '' when the line is removed. */
export function layoutLines(an: Analysis, opts: FormatOptions, ind: IndentResult): string[] {
  const { lines, tokens, text } = an;
  const n = lines.length;
  const out: string[] = new Array(n);
  const indentOf = (l: number): string | undefined => {
    const w = ind.width[l];
    return ind.balanced && w !== undefined ? makeIndent(w, opts.insertSpaces, opts.tabSize) : undefined;
  };
  const trimEnd = (s: string) => (opts.trimTrailingWhitespace ? s.replace(/\s+$/, '') : s);
  const endsWithBackslash = (s: string) => /\\\s*$/.test(s);

  for (let l = 0; l < n; l++) {
    const line = lines[l];
    const orig = line.text;
    const kind = an.kind[l];
    let body: string;
    if (an.off[l] || kind === 'raw' || (an.continued[l] && kind !== 'directive' && kind !== 'directiveCont')) body = orig;
    else if (kind === 'blank') body = trimEnd(orig);
    else if (kind === 'directive' || kind === 'directiveCont') {
      if (endsWithBackslash(orig)) body = orig;
      else {
        const ws = kind === 'directive' ? indentOf(l) : undefined;
        body = trimEnd(ws !== undefined ? ws + orig.slice(leadingWhitespace(orig).length) : orig);
      }
    } else if (kind === 'commentCont') body = trimEnd(shiftCommentLine(an, l, indentOf) ?? orig);
    else if (an.continued[l]) body = orig;
    else {
      const ws = indentOf(l) ?? leadingWhitespace(orig);
      // A trailing comment aligned with the one on an adjacent line keeps its absolute column.
      const c = ind.commentCol[l];
      const aligned = c !== undefined && (ind.commentCol[l - 1] === c || ind.commentCol[l + 1] === c) ? c : undefined;
      body = trimEnd(ws + respace(an, l, opts, ws, aligned));
    }
    out[l] = body + line.eol;
  }

  collapseBlankLines(an, opts, out);
  finalNewline(an, opts, out, detectEol(text));
  return out;
}

/**
 * The line's content from its first token on, with gaps decided by the mode.
 * A trailing comment goes to `alignedCol` (absolute, after the new indentation
 * `ws`) when given and possible, else keeps its column relative to the
 * line's content when it was padded.
 */
function respace(an: Analysis, l: number, opts: FormatOptions, ws: string, alignedCol: number | undefined): string {
  const { tokens, text, lines } = an;
  const { lo, hi } = an.lineTokens[l];
  const line = lines[l];
  const lineEnd = line.start + line.text.length;
  const contentStart = tokens[lo].start;
  let s = '';
  let prev: Token | undefined;
  for (let i = lo; i < hi; i++) {
    const t = tokens[i];
    if (prev) {
      const gap = text.slice(prev.end, t.start);
      let next = opts.mode === 'opinionated' ? opinionatedGap(an, i - 1, i) : conservativeGap(an, i - 1, i, gap);
      if (next === '' && !canJoin(prev, t)) next = ' ';
      const trailing = isCommentToken(t) && !isCommentToken(prev) && i === hi - 1;
      const absolute = trailing && alignedCol !== undefined && /^ +$/.test(gap) ? alignedCol - visualWidth(ws + s, opts.tabSize) : 0;
      if (absolute >= 1) next = ' '.repeat(absolute);
      else if (isCommentToken(t) && !isCommentToken(prev) && /^ {2,}$/.test(gap)) {
        // Padded trailing comment: keep its column relative to the line's content.
        next = ' '.repeat(Math.max(1, t.start - contentStart - s.length));
      }
      s += next ?? gap;
    }
    s += t.endLine > l ? text.slice(t.start, lineEnd) : t.text;
    prev = t;
  }
  if (prev && prev.endLine === l) s += text.slice(prev.end, lineEnd);
  return s;
}

/**
 * A line inside a block comment that starts a line: moved with the comment's
 * first line, when every non-blank line of the comment starts with that first
 * line's original indentation (so nothing but that indentation changes).
 */
function shiftCommentLine(an: Analysis, l: number, indentOf: (l: number) => string | undefined): string | undefined {
  const c = an.coveredBy[l];
  const tok = an.tokens[c];
  if (!tok || tok.kind !== 'blockComment') return undefined;
  const s = tok.line;
  if (an.lineTokens[s].lo !== c || an.kind[s] !== 'code' || an.off[s] || an.continued[s]) return undefined;
  const newIndent = indentOf(s);
  if (newIndent === undefined) return undefined;
  const oldIndent = leadingWhitespace(an.lines[s].text);
  if (newIndent === oldIndent) return undefined;
  for (let k = s + 1; k <= tok.endLine && k < an.lines.length; k++) {
    const t = an.lines[k].text;
    if (an.off[k]) return undefined;
    if (t.trim() !== '' && !t.startsWith(oldIndent)) return undefined;
  }
  const t = an.lines[l].text;
  if (t.trim() === '') return t;
  return newIndent + t.slice(oldIndent.length);
}

/** Runs of blank lines (outside protected regions) longer than maxBlankLines are shortened. */
function collapseBlankLines(an: Analysis, opts: FormatOptions, out: string[]) {
  let run = 0;
  for (let l = 0; l < out.length; l++) {
    if (an.kind[l] === 'blank' && !an.off[l] && !an.continued[l]) {
      run++;
      if (run > opts.maxBlankLines) out[l] = '';
    } else run = 0;
  }
}

function finalNewline(an: Analysis, opts: FormatOptions, out: string[], eol: string) {
  if (opts.trimFinalNewlines) {
    for (let l = out.length - 1; l >= 0; l--) {
      if (an.kind[l] === 'blank' && !an.off[l] && !an.continued[l]) out[l] = '';
      else break;
    }
  }
  if (opts.insertFinalNewline) {
    for (let l = out.length - 1; l >= 0; l--) {
      if (out[l] === '') continue;
      // A final backslash would turn the new line break into a line continuation.
      if (!/[\r\n]$/.test(out[l]) && !/\\\s*$/.test(out[l])) out[l] += eol;
      break;
    }
  }
}
