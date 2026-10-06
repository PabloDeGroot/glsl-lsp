// GLSL formatter: pure functions from text to minimal TextEdits. No vscode
// imports; features/format.ts wires them to the LSP requests.
//
// Pipeline: analyze (lex once) -> placeBraces (opinionated brace style only)
// -> computeIndentation -> layoutLines -> edits per group of original lines,
// trimmed to the changed characters. A result that would change the token
// sequence (it never should) is dropped rather than applied.

import { LineIndex, type Range } from '../../core/text';
import { analyze, tokenSignature, type Analysis } from './analyze';
import { placeBraces, type PlacedLine } from './braces';
import { computeIndentation } from './indent';
import { layoutLines } from './layout';
import { detectEol, leadingWhitespace, makeIndent } from './lines';
import { resolveFormatOptions, type EditorFormattingOptions, type FormatOptions, type FormatSettings } from './options';

export * from './options';
export { analyze, tokenSignature } from './analyze';

export interface FormatEdit {
  range: Range;
  newText: string;
}

interface Group {
  from: number;
  to: number;
  newText: string;
}

interface Formatted {
  text: string;
  groups: Group[];
  original: Analysis;
}

function run(text: string, opts: FormatOptions): Formatted {
  const original = analyze(text);
  const identity = (): PlacedLine[] => original.lines.map((l, i) => ({ text: l.text, eol: l.eol, from: i, to: i }));
  let placed = opts.mode === 'opinionated' && opts.braceStyle !== 'preserve' ? placeBraces(original, opts.braceStyle, detectEol(text)) : identity();
  let an = original;
  if (placed.some((p) => p.from !== p.to) || placed.length !== original.lines.length) {
    an = analyze(placed.map((p) => p.text + p.eol).join(''));
    if (an.lines.length !== placed.length) {
      placed = identity();
      an = original;
    }
  }
  const outs = layoutLines(an, opts, computeIndentation(an, opts));
  const groups: Group[] = [];
  for (let k = 0; k < placed.length; k++) {
    const p = placed[k];
    const g = groups[groups.length - 1];
    if (g && p.from <= g.to) {
      g.to = Math.max(g.to, p.to);
      g.newText += outs[k];
    } else groups.push({ from: p.from, to: p.to, newText: outs[k] });
  }
  return { text: outs.join(''), groups, original };
}

/** The whole document formatted (tests, and the token-preservation guard). */
export function formatText(text: string, opts: FormatOptions): string {
  if (opts.mode === 'off') return text;
  return run(text, opts).text;
}

/** True when both texts have the same tokens (comment and directive whitespace aside). */
export function sameTokens(a: string, b: string): boolean {
  const x = tokenSignature(a);
  const y = tokenSignature(b);
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

/** Minimal edit turning `oldText` (at `offset` in the document) into `newText`. */
function trimmedEdit(index: LineIndex, offset: number, oldText: string, newText: string): FormatEdit | undefined {
  if (oldText === newText) return undefined;
  let p = 0;
  const max = Math.min(oldText.length, newText.length);
  while (p < max && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
  // Never split a \r\n.
  if (p > 0 && oldText.charCodeAt(p - 1) === 13 && (oldText.charCodeAt(p) === 10 || newText.charCodeAt(p) === 10)) p--;
  let s = 0;
  while (s < max - p && oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)) s++;
  if (s > 0 && oldText.charCodeAt(oldText.length - s) === 10 && (oldText.charCodeAt(oldText.length - s - 1) === 13 || newText.charCodeAt(newText.length - s - 1) === 13)) s--;
  return {
    range: index.range(offset + p, offset + oldText.length - s),
    newText: newText.slice(p, newText.length - s),
  };
}

/**
 * Edits formatting `text`. With `lines`, only groups of whole lines inside
 * [lines.start, lines.end] are changed (range formatting); indentation still
 * comes from the whole document.
 */
export function computeFormatEdits(text: string, opts: FormatOptions, lines?: { start: number; end: number }): FormatEdit[] {
  if (opts.mode === 'off' || text.length === 0) return [];
  const f = run(text, opts);
  if (f.text === text) return [];
  if (!sameTokens(text, f.text)) return [];
  const index = new LineIndex(text);
  const src = f.original.lines;
  const edits: FormatEdit[] = [];
  for (const g of f.groups) {
    if (lines && (g.from < lines.start || g.to > lines.end)) continue;
    const start = src[g.from].start;
    const end = g.to + 1 < src.length ? src[g.to + 1].start : text.length;
    const e = trimmedEdit(index, start, text.slice(start, end), g.newText);
    if (e) edits.push(e);
  }
  return edits;
}

/** Re-indents only the given lines (format on type). */
export function computeIndentEdits(text: string, opts: FormatOptions, targetLines: number[]): FormatEdit[] {
  if (opts.mode === 'off') return [];
  const an = analyze(text);
  const ind = computeIndentation(an, opts);
  const index = new LineIndex(text);
  const edits: FormatEdit[] = [];
  for (const l of targetLines) {
    if (l < 0 || l >= an.lines.length || an.off[l] || an.continued[l]) continue;
    if (an.kind[l] !== 'code' && an.kind[l] !== 'blank') continue;
    const w = ind.width[l];
    if (w === undefined) continue;
    const line = an.lines[l];
    const oldWs = an.kind[l] === 'blank' ? line.text : leadingWhitespace(line.text);
    const newWs = makeIndent(w, opts.insertSpaces, opts.tabSize);
    if (oldWs === newWs) continue;
    edits.push({ range: index.range(line.start, line.start + oldWs.length), newText: newWs });
  }
  return edits;
}

// ---------------------------------------------------------------- entry points (never throw)

export function formatDocument(text: string, editor: EditorFormattingOptions | undefined, settings: Partial<FormatSettings> | undefined): FormatEdit[] {
  try {
    return computeFormatEdits(text, resolveFormatOptions(editor, settings));
  } catch {
    return [];
  }
}

export function formatRange(text: string, range: Range, editor: EditorFormattingOptions | undefined, settings: Partial<FormatSettings> | undefined): FormatEdit[] {
  try {
    const start = Math.max(0, range.start.line);
    let end = range.end.line;
    if (range.end.character === 0 && end > start) end--;
    return computeFormatEdits(text, resolveFormatOptions(editor, settings), { start, end });
  } catch {
    return [];
  }
}

/** Format on type: `}` and `;` re-indent their line, a new line (`\n`) the line the cursor is on. */
export function formatOnType(
  text: string,
  position: { line: number; character: number },
  ch: string,
  editor: EditorFormattingOptions | undefined,
  settings: Partial<FormatSettings> | undefined,
): FormatEdit[] {
  try {
    if (ch !== '}' && ch !== ';' && ch !== '\n') return [];
    return computeIndentEdits(text, resolveFormatOptions(editor, settings), [position.line]);
  } catch {
    return [];
  }
}
