// Classifies the cursor position for completion: inside a comment, a
// preprocessor line (directive name, #include path, #ifdef macro, #define
// body...), after `.` (member access) or on a plain identifier.

import { tokenIndexAt, type FileModel, type Token } from '../../core';

export type CompletionContextKind =
  | { kind: 'none' }
  /** After `#`: directive names. `word` is the partial name. */
  | { kind: 'directiveName'; word: string; wordStart: number }
  /** Inside `#include "...`: `typed` is the path text between the quote and the cursor. */
  | { kind: 'includePath'; typed: string; typedStart: number; quote: '"' | '<'; hasClosingQuote: boolean; after?: string }
  /** `#ifdef X`, `#ifndef X`, `#undef X`, `#if ... X`, `#elif ... X`: macro names. */
  | { kind: 'macroName'; word: string; wordStart: number; allowDefined: boolean }
  /** `#version |` */
  | { kind: 'version'; word: string; wordStart: number }
  /** `#extension |` */
  | { kind: 'extension'; word: string; wordStart: number }
  /** After `.`: `dot` is the offset of the dot. */
  | { kind: 'member'; word: string; wordStart: number; dot: number }
  /** Plain identifier position. `inDirective` for #define bodies (no locals, no auto-include). */
  | { kind: 'identifier'; word: string; wordStart: number; inDirective: boolean };

function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/** Start offset of the identifier ending at `offset`. */
export function wordStartBefore(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && isIdentChar(text.charAt(i - 1))) i--;
  return i;
}

function isCommentToken(t: Token | undefined): boolean {
  return !!t && (t.kind === 'lineComment' || t.kind === 'blockComment');
}

/** True when `offset` lies inside a comment (cursor after `//` or between `/*` and `*\/`). */
export function inComment(model: FileModel, offset: number): boolean {
  const tokens = model.tokens;
  const idx = tokenIndexAt(tokens, offset);
  const check = (t: Token | undefined) => {
    if (!isCommentToken(t) || !t) return false;
    if (offset <= t.start) return false;
    if (t.kind === 'lineComment') return offset <= t.end;
    const closed = t.text.length >= 4 && t.text.endsWith('*/');
    return closed ? offset < t.end : offset <= t.end;
  };
  if (idx >= 0) return check(tokens[idx - 1]) || check(tokens[idx]) || check(tokens[idx + 1]);
  // Between tokens: the closest token before the offset may be an unterminated block comment.
  let lo = 0;
  let hi = tokens.length - 1;
  let before = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start < offset) {
      before = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return before >= 0 && check(tokens[before]);
}

/** Text of the preprocessor line from its `#` up to `offset`, or undefined when not on a directive line. */
function directivePrefix(model: FileModel, offset: number): { text: string; start: number } | undefined {
  const lines = model.lines;
  let line = lines.lineAt(offset);
  // Follow backslash continuations upwards.
  while (line > 0 && /\\\s*$/.test(lines.lineText(line - 1))) line--;
  const start = lines.lineStarts[line];
  const text = model.text.slice(start, offset);
  const m = /^[ \t]*#/.exec(text);
  if (!m) return undefined;
  const hash = start + m[0].length - 1;
  return { text: model.text.slice(hash, offset), start: hash };
}

export function analyzeContext(model: FileModel, offset: number): CompletionContextKind {
  const text = model.text;
  if (inComment(model, offset)) return { kind: 'none' };

  const directive = directivePrefix(model, offset);
  if (directive) return analyzeDirective(model, directive.text, offset);

  const wordStart = wordStartBefore(text, offset);
  const word = text.slice(wordStart, offset);
  if (/^[0-9]/.test(word)) return { kind: 'none' };
  let i = wordStart - 1;
  while (i >= 0 && (text.charAt(i) === ' ' || text.charAt(i) === '\t')) i--;
  if (text.charAt(i) === '.') {
    // `1.` / `.5` are numbers, not member access.
    let j = i - 1;
    while (j >= 0 && /\s/.test(text.charAt(j))) j--;
    const prev = text.charAt(j);
    if (/[0-9]/.test(prev)) {
      const ws = wordStartBefore(text, j + 1);
      if (/^[0-9]/.test(text.slice(ws, j + 1))) return { kind: 'none' };
    }
    if (j < 0 || !(isIdentChar(prev) || prev === ')' || prev === ']')) return { kind: 'none' };
    return { kind: 'member', word, wordStart, dot: i };
  }
  return { kind: 'identifier', word, wordStart, inDirective: false };
}

function analyzeDirective(model: FileModel, line: string, offset: number): CompletionContextKind {
  // `#` + optional whitespace + partial name
  let m = /^#[ \t]*(\w*)$/.exec(line);
  if (m) return { kind: 'directiveName', word: m[1], wordStart: offset - m[1].length };

  m = /^#[ \t]*include[ \t]*(["<])([^"<>]*)$/.exec(line);
  if (m) {
    const quote = m[1] as '"' | '<';
    const close = quote === '"' ? '"' : '>';
    const lineEnd = model.lines.lineEnd(model.lines.lineAt(offset));
    const rest = model.text.slice(offset, lineEnd);
    return { kind: 'includePath', typed: m[2], typedStart: offset - m[2].length, quote, hasClosingQuote: rest.includes(close), after: rest };
  }

  const word = /\w*$/.exec(line)![0];
  const wordStart = offset - word.length;
  if (/^[0-9]/.test(word)) return { kind: 'none' };

  m = /^#[ \t]*(ifdef|ifndef|undef)[ \t]+\w*$/.exec(line);
  if (m) return { kind: 'macroName', word, wordStart, allowDefined: false };
  if (/^#[ \t]*(if|elif)\b/.test(line)) return { kind: 'macroName', word, wordStart, allowDefined: true };
  if (/^#[ \t]*version[ \t]+\w*$/.test(line)) return { kind: 'version', word, wordStart };
  if (/^#[ \t]*extension[ \t]+\w*$/.test(line)) return { kind: 'extension', word, wordStart };

  // `#define NAME body|` or `#define F(a, b) body|`: identifiers in the body.
  m = /^#[ \t]*define[ \t]+\w+(\([^)]*\))?[ \t]+/.exec(line);
  if (m) {
    const before = model.text.charAt(wordStart - 1);
    if (before === '.') return { kind: 'none' };
    return { kind: 'identifier', word, wordStart, inDirective: true };
  }
  return { kind: 'none' };
}
