// Where and how to insert a new `#include "..."` line (auto-include on
// completion, "add missing include" code actions).

import type { FileModel } from './model';
import type { Position } from './text';

export interface IncludeInsertion {
  /** Insert position (start of a line). */
  position: Position;
  /** Text to insert, ending with a newline. */
  text: string;
}

/** True if `model` already has an `#include` whose path text equals `path` (ignoring ./ and slashes). */
export function hasIncludePath(model: FileModel, path: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  return model.includes.some((i) => norm(i.path) === norm(path));
}

type Tok = FileModel['tokens'][number];

const isCommentTok = (t: Tok | undefined) => t?.kind === 'lineComment' || t?.kind === 'blockComment';
const directiveName = (t: Tok) => /^#\s*(\w+)/.exec(t.text)?.[1] ?? '';

/** Index of the next non-comment token after `i`, or -1. */
function nextSignificant(tokens: readonly Tok[], i: number): number {
  for (let k = i + 1; k < tokens.length; k++) if (!isCommentTok(tokens[k])) return k;
  return -1;
}

/** `precision <qualifier> <type>;` starting at token `i`: index of its `;`, or -1. */
function precisionStatement(tokens: readonly Tok[], i: number): number {
  if (tokens[i]?.text !== 'precision') return -1;
  for (let k = i + 1, n = 0; k < tokens.length && n < 3; k++) {
    const t = tokens[k];
    if (isCommentTok(t)) continue;
    if (t.text === ';') return k;
    if (t.kind === 'directive') return -1;
    n++;
  }
  return -1;
}

/** Index of the `#endif` closing the conditional opened at token `i`, or -1. */
function matchingEndif(tokens: readonly Tok[], i: number): number {
  let depth = 0;
  for (let k = i; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'directive') continue;
    const n = directiveName(t);
    if (n === 'if' || n === 'ifdef' || n === 'ifndef') depth++;
    else if (n === 'endif' && --depth === 0) return k;
  }
  return -1;
}

/**
 * `#ifndef X` at token `i` opening an include guard: followed by `#define X`
 * without a value, and closed by the last directive/code of the file.
 * Returns the index of the `#define`, or -1.
 */
function includeGuardDefine(tokens: readonly Tok[], i: number): number {
  const name = /^#\s*ifndef\s+(\w+)/.exec(tokens[i].text)?.[1];
  const d = nextSignificant(tokens, i);
  if (!name || d < 0) return -1;
  const def = /^#\s*define\s+(\w+)\s*(.*)$/s.exec(tokens[d].text);
  if (!def || def[1] !== name || def[2].replace(/\/\*[\s\S]*?\*\/|\/\/.*$/g, '').trim()) return -1;
  const end = matchingEndif(tokens, i);
  return end >= 0 && nextSignificant(tokens, end) < 0 ? d : -1;
}

/** `#ifndef X` / `#define X value` / `#endif` option-default group at `i`: index of its `#endif`, or -1. */
function optionDefaultGroup(tokens: readonly Tok[], i: number): number {
  const name = /^#\s*ifndef\s+(\w+)/.exec(tokens[i].text)?.[1];
  const d = nextSignificant(tokens, i);
  if (!name || d < 0 || tokens[d].kind !== 'directive') return -1;
  if (/^#\s*define\s+(\w+)/.exec(tokens[d].text)?.[1] !== name) return -1;
  const e = nextSignificant(tokens, d);
  return e >= 0 && tokens[e].kind === 'directive' && directiveName(tokens[e]) === 'endif' ? e : -1;
}

/** Lines of the `#include`s at file scope: outside conditionals (an include guard does not count) and before any code. */
function topLevelIncludeLines(model: FileModel): number[] {
  const tokens = model.tokens;
  const lines: number[] = [];
  let depth = 0;
  let guardEnd = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isCommentTok(t)) continue;
    const prec = precisionStatement(tokens, i);
    if (prec >= 0) {
      i = prec;
      continue;
    }
    if (t.kind !== 'directive') break; // code: includes below it would come after their uses
    const n = directiveName(t);
    if (n === 'ifndef' && depth === 0 && guardEnd < 0 && includeGuardDefine(tokens, i) >= 0) {
      guardEnd = matchingEndif(tokens, i);
      continue;
    }
    if (n === 'if' || n === 'ifdef' || n === 'ifndef') depth++;
    else if (n === 'endif') {
      if (i === guardEnd) continue;
      depth = Math.max(0, depth - 1);
    } else if (n === 'include' && depth === 0) lines.push(t.endLine);
  }
  return lines;
}

/**
 * Insertion point for `#include "<includePath>"`:
 *  - after the last top-level #include (outside conditionals, before code),
 *  - else after the leading block of #version / #extension / `precision`
 *    statements / shader-toy directives / include guard / option `#define`s (and `#ifndef X`
 *    `#define X v` `#endif` defaults) / header comment, so LYGIA options set
 *    by the file stay in front of the library,
 *  - else at the top of the file.
 */
export function computeIncludeInsertion(model: FileModel, includePath: string): IncludeInsertion {
  const line = `#include "${includePath}"`;
  const top = topLevelIncludeLines(model);
  if (top.length) return { position: { line: top[top.length - 1] + 1, character: 0 }, text: line + '\n' };
  let insertLine = 0;
  let afterComment = false;
  const tokens = model.tokens;
  let i = 0;
  // Header comment run at the very top (no blank-line gaps). It is a header
  // only when a blank line, a directive or the end of the file follows it;
  // otherwise it documents the first declaration and must stay attached.
  if (isCommentTok(tokens[0]) && tokens[0].line === 0) {
    while (isCommentTok(tokens[i]) && (i === 0 || tokens[i].line <= tokens[i - 1].endLine + 1)) i++;
    const last = tokens[i - 1];
    const next = tokens[i];
    const header = !next || next.kind === 'directive' || next.line > last.endLine + 1;
    if (header && !(next && next.line === last.endLine)) {
      insertLine = last.endLine + 1;
      afterComment = true;
    } else i = 0;
  }
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    // Comments between leading directives neither move the insertion point nor stop the scan.
    if (isCommentTok(t)) continue;
    const prec = precisionStatement(tokens, i);
    if (prec >= 0) {
      insertLine = tokens[prec].endLine + 1;
      i = prec;
      afterComment = false;
      continue;
    }
    if (t.kind !== 'directive') break;
    const name = directiveName(t);
    if (/^(version|extension|pragma|iKeyboard|iUniform|iMouse|define|undef)$/.test(name) || name.startsWith('iChannel')) {
      insertLine = t.endLine + 1;
      afterComment = false;
      continue;
    }
    if (name === 'ifndef') {
      const guard = includeGuardDefine(tokens, i);
      if (guard >= 0) {
        insertLine = tokens[guard].endLine + 1;
        i = guard;
        afterComment = false;
        continue;
      }
      const endif = optionDefaultGroup(tokens, i);
      if (endif >= 0) {
        insertLine = tokens[endif].endLine + 1;
        i = endif;
        afterComment = false;
        continue;
      }
    }
    break;
  }
  const lineAfter = model.lines.lineCount > insertLine ? model.lines.lineText(insertLine) : '';
  const prefix = afterComment && insertLine > 0 ? '\n' : '';
  const suffix = lineAfter.trim() ? '\n' : '';
  return { position: { line: insertLine, character: 0 }, text: prefix + line + '\n' + suffix };
}

/** True when the file has includes and every one of them uses `<...>`. */
export function usesAngleBrackets(model: FileModel): boolean {
  if (!model.includes.length) return false;
  return model.includes.every((inc) => model.text.charAt(model.lines.offsetAt(inc.pathRange.start) - 1) === '<');
}

/**
 * Ready-to-apply insertion of `#include "<path>"`: the position from
 * `computeIncludeInsertion`, adjusted for the file's quote style (`<...>`
 * when every existing include uses it), its line endings (CRLF), and a last
 * line without a trailing newline (the edit then appends after that line).
 */
export function includeInsertionEdit(model: FileModel, includePath: string): IncludeInsertion {
  const ins = computeIncludeInsertion(model, includePath);
  let text = ins.text;
  if (usesAngleBrackets(model)) text = text.replace(`"${includePath}"`, `<${includePath}>`);
  let position = ins.position;
  const lastLine = model.lines.lineCount - 1;
  if (position.line > lastLine) {
    position = { line: lastLine, character: model.lines.lineText(lastLine).length };
    text = '\n' + text.replace(/\n$/, '');
  }
  if (model.text.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
  return { position, text };
}
