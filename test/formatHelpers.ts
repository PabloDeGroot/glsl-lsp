// Helpers for the formatter tests: applying edits, and the invariant checks
// shared by the unit fixtures and the real-workspace run.

import { LineIndex } from '../server/src/core/text';
import {
  computeFormatEdits,
  formatText,
  resolveFormatOptions,
  sameTokens,
  type EditorFormattingOptions,
  type FormatEdit,
  type FormatSettings,
} from '../server/src/features/format/index';

export function applyEdits(text: string, edits: FormatEdit[]): string {
  const index = new LineIndex(text);
  const spans = edits
    .map((e) => ({ start: index.offsetAt(e.range.start), end: index.offsetAt(e.range.end), text: e.newText }))
    .sort((a, b) => b.start - a.start);
  for (let i = 1; i < spans.length; i++) if (spans[i].end > spans[i - 1].start) throw new Error('overlapping edits');
  let out = text;
  for (const s of spans) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

/** Formats `text` through the edit path (what the server returns), checked against the whole-text path. */
export function fmt(text: string, settings: Partial<FormatSettings> = {}, editor: EditorFormattingOptions = { tabSize: 4, insertSpaces: true }): string {
  const opts = resolveFormatOptions(editor, settings);
  const whole = formatText(text, opts);
  const viaEdits = applyEdits(text, computeFormatEdits(text, opts));
  if (viaEdits !== whole) throw new Error(`edits and whole-text formatting differ:\n${JSON.stringify(viaEdits)}\n${JSON.stringify(whole)}`);
  return whole;
}

/** Problems with invariants 1 and 2 (token preservation, idempotence); [] when fine. */
export function invariantProblems(text: string, settings: Partial<FormatSettings>, editor: EditorFormattingOptions = { tabSize: 4, insertSpaces: true }): string[] {
  const opts = resolveFormatOptions(editor, settings);
  const once = formatText(text, opts);
  const twice = formatText(once, opts);
  const problems: string[] = [];
  if (!sameTokens(text, once)) problems.push('tokens changed');
  if (twice !== once) problems.push('not idempotent');
  return problems;
}

const ASSIGNMENT = ['<<=', '>>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '='];

/**
 * Invariant 3: conservative output differs from its input only by the listed
 * changes. Non-blank lines pair up in order (conservative never joins or
 * splits lines); within a pair, besides leading and trailing whitespace, a
 * single space may be inserted after `,` / `;` or around an assignment, and a
 * run of spaces may only shrink right before a trailing comment (it keeps its
 * column). Returns a description of the first violation, or undefined.
 */
export function conservativeViolation(orig: string, out: string): string | undefined {
  const a = orig.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  const b = out.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (a.length !== b.length) return `non-blank line count ${a.length} -> ${b.length}`;
  for (let k = 0; k < a.length; k++) {
    const o = a[k].trim();
    const m = b[k].trim();
    if (o === m) continue;
    let i = 0;
    let j = 0;
    while (i < o.length || j < m.length) {
      if (o[i] === m[j]) {
        i++;
        j++;
        continue;
      }
      if (m[j] === ' ' && (o[i] !== ' ' && o[i] !== '\t')) {
        // Inserted space: after `,`/`;`/assignment, or before an assignment.
        const before = m.slice(0, j);
        const after = m.slice(j + 1);
        const ok = /[,;]$/.test(before) || ASSIGNMENT.some((op) => before.endsWith(op) || after.startsWith(op)) || /^(\/\/|\/\*)/.test(after);
        if (!ok) return `line ${k + 1}: unexpected space inserted at ${j}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`;
        j++;
        continue;
      }
      if (o[i] === ' ' && /^ *(\/\/|\/\*)/.test(o.slice(i))) {
        // Shrunk run before a trailing comment.
        i++;
        continue;
      }
      return `line ${k + 1}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`;
    }
  }
  return undefined;
}
