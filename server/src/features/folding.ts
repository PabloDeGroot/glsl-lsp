// Folding ranges and selection ranges (expand/shrink selection).
//
// Folding is derived from `model.folding` (raw extents from the parser) plus
// conditional groups (`#if ... #endif`) computed here so the closing line
// (`}`, `#else`, `#endif`) stays visible when folded.
// Selection ranges chain: word -> call argument -> call -> bracket contents ->
// bracket pair -> statement -> enclosing blocks -> function -> file.

import { FoldingRangeKind, type FoldingRange, type SelectionRange } from 'vscode-languageserver/node';
import type { ServerContext } from '../context';
import type { FileModel, Position, Scope, Token } from '../core';

// ---------------------------------------------------------------- folding

/** Pure folding computation. */
export function computeFoldingRanges(model: FileModel): FoldingRange[] {
  const out = new Map<string, FoldingRange>();
  const add = (startLine: number, endLine: number, kind?: string) => {
    if (endLine <= startLine) return;
    const key = `${startLine}:${endLine}`;
    if (!out.has(key)) out.set(key, { startLine, endLine, kind });
  };
  const lineStartsWithCloser = (line: number) => /^\s*[}\])]/.test(model.lines.lineText(line));
  const lineIsDirective = (line: number) => /^\s*#/.test(model.lines.lineText(line));

  for (const r of model.folding) {
    switch (r.kind) {
      case 'code': {
        // Conditional branches are handled below (they start on a '#' line).
        if (lineIsDirective(r.startLine)) break;
        const end = lineStartsWithCloser(r.endLine) ? r.endLine - 1 : r.endLine;
        add(r.startLine, end);
        break;
      }
      case 'comment':
        add(r.startLine, r.endLine, FoldingRangeKind.Comment);
        break;
      case 'imports':
        add(r.startLine, r.endLine, FoldingRangeKind.Imports);
        break;
      case 'region':
        add(r.startLine, r.endLine, FoldingRangeKind.Region);
        break;
    }
  }
  // #if / #ifdef / #ifndef groups: each branch folds up to the line before the next branch / #endif.
  for (const c of model.conditionals) {
    const parts = c.endif ? [...c.branches, c.endif] : c.branches;
    for (let k = 0; k + 1 < parts.length; k++) {
      add(parts[k].range.start.line, parts[k + 1].range.start.line - 1, FoldingRangeKind.Region);
    }
  }
  return [...out.values()].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}

// ---------------------------------------------------------------- selection

type Span = [number, number];

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

function isCodeToken(t: Token): boolean {
  return t.kind !== 'lineComment' && t.kind !== 'blockComment';
}

/** Index of the token containing `offset` (inclusive of its end for identifiers/numbers), or -1. */
function wordTokenAt(tokens: readonly Token[], offset: number): number {
  let lo = 0;
  let hi = tokens.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = tokens[mid];
    if (offset < t.start) hi = mid - 1;
    else if (offset > t.end) lo = mid + 1;
    else {
      found = mid;
      // prefer the token starting at offset when touching two tokens
      if (offset === t.start && mid > 0 && tokens[mid - 1].end === offset && tokens[mid - 1].kind !== 'ident' && tokens[mid - 1].kind !== 'number') break;
      if (offset === t.end && t.kind !== 'ident' && t.kind !== 'number' && mid + 1 < tokens.length && tokens[mid + 1].start === offset) {
        found = mid + 1;
      }
      break;
    }
  }
  if (found < 0) return -1;
  const t = tokens[found];
  if (t.kind === 'ident' || t.kind === 'number' || t.kind === 'string') return found;
  // Cursor right after an identifier.
  if (found > 0 && tokens[found - 1].end === offset && (tokens[found - 1].kind === 'ident' || tokens[found - 1].kind === 'number')) return found - 1;
  return -1;
}

/** Statement span (start of first token .. end incl. `;` or closing `}`) around `offset` inside `[from, to)`. */
function statementSpan(model: FileModel, from: number, to: number, offset: number): Span | undefined {
  const toks = model.tokens;
  // first token index at or after `from`
  let lo = 0;
  let hi = toks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].start < from) lo = mid + 1;
    else hi = mid;
  }
  let start = -1;
  let depth = 0;
  for (let i = lo; i < toks.length && toks[i].start < to; i++) {
    const t = toks[i];
    if (!isCodeToken(t)) continue;
    if (t.kind === 'directive') {
      if (depth === 0) {
        // a directive is a statement of its own
        if (start >= 0) start = -1;
        if (t.start <= offset && offset <= t.end) return [t.start, t.end];
        continue;
      }
      continue;
    }
    if (start < 0) start = t.start;
    let endsHere = false;
    if (t.kind === 'punct') {
      if (t.text in OPENERS) depth++;
      else if (t.text === ')' || t.text === ']') depth = Math.max(0, depth - 1);
      else if (t.text === '}') {
        depth = Math.max(0, depth - 1);
        if (depth === 0) {
          let n = i + 1;
          while (n < toks.length && !isCodeToken(toks[n])) n++;
          const next = toks[n];
          const continues = next && next.kind === 'ident' && (next.text === 'else' || next.text === 'while');
          const isInit = next && next.kind === 'punct' && (next.text === ';' || next.text === ',');
          if (!continues && !isInit) endsHere = true;
        }
      } else if (t.text === ';' && depth === 0) endsHere = true;
    }
    if (endsHere) {
      if (start <= offset && offset <= t.end) return [start, t.end];
      if (t.start > offset) return undefined;
      start = -1;
    }
  }
  if (start >= 0 && start <= offset) {
    // unterminated trailing statement
    let last = start;
    for (let i = toks.length - 1; i >= 0; i--) {
      if (toks[i].end <= to && isCodeToken(toks[i])) {
        last = toks[i].end;
        break;
      }
    }
    if (offset <= last) return [start, last];
  }
  return undefined;
}

/** Candidate spans (all containing `offset`) for the selection chain. */
function candidateSpans(model: FileModel, offset: number): Span[] {
  const spans: Span[] = [];
  const contains = (s: number, e: number) => s <= offset && offset <= e;

  const w = wordTokenAt(model.tokens, offset);
  if (w >= 0) spans.push([model.tokens[w].start, model.tokens[w].end]);

  for (const call of model.calls) {
    const s = model.lines.offsetAt(call.range.start);
    const e = model.lines.offsetAt(call.range.end);
    if (!contains(s, e)) continue;
    spans.push([s, e]);
    for (const a of call.args) {
      const as = model.lines.offsetAt(a.start);
      const ae = model.lines.offsetAt(a.end);
      if (contains(as, ae)) spans.push([as, ae]);
    }
  }

  let innermostBrace: BracePair | undefined;
  for (const b of model.brackets) {
    const close = b.close ?? model.text.length;
    const closeEnd = b.close !== undefined ? b.close + 1 : close;
    if (!(b.open <= offset && offset <= closeEnd)) continue;
    spans.push([b.open, closeEnd]);
    if (offset > b.open && offset <= close && close > b.open + 1) spans.push([b.open + 1, close]);
    if (b.char === '{' && (!innermostBrace || b.open > innermostBrace.open)) innermostBrace = { open: b.open, close };
  }

  // Statements: the innermost brace body, then the file.
  const from = innermostBrace ? innermostBrace.open + 1 : 0;
  const to = innermostBrace ? innermostBrace.close : model.text.length;
  const stmt = statementSpan(model, from, to, offset);
  if (stmt) spans.push(stmt);
  if (innermostBrace) {
    const outer = statementSpan(model, 0, model.text.length, innermostBrace.open);
    if (outer) spans.push(outer);
  }

  // Scopes and functions.
  const visit = (s: Scope) => {
    if (s.kind !== 'file' && contains(s.start, s.end)) spans.push([s.start, s.end]);
    for (const c of s.children) if (contains(c.start, c.end)) visit(c);
  };
  visit(model.rootScope);
  for (const f of model.functions) {
    const s = model.lines.offsetAt(f.range.start);
    const e = model.lines.offsetAt(f.range.end);
    if (contains(s, e)) spans.push([s, e]);
  }

  spans.push([0, model.text.length]);
  return spans;
}

interface BracePair {
  open: number;
  close: number;
}

/** Pure selection-range computation for one position. */
export function computeSelectionRange(model: FileModel, position: Position): SelectionRange {
  const offset = model.lines.offsetAt(position);
  const spans = candidateSpans(model, offset).filter(([s, e]) => e >= s);
  spans.sort((a, b) => a[1] - a[0] - (b[1] - b[0]) || a[0] - b[0]);
  const chain: Span[] = [];
  for (const sp of spans) {
    const prev = chain[chain.length - 1];
    if (prev && prev[0] === sp[0] && prev[1] === sp[1]) continue;
    if (prev && !(sp[0] <= prev[0] && prev[1] <= sp[1])) continue; // not nested: drop
    chain.push(sp);
  }
  if (chain.length === 0) chain.push([offset, offset]);
  let parent: SelectionRange | undefined;
  for (let i = chain.length - 1; i >= 0; i--) {
    parent = { range: model.lines.range(chain[i][0], chain[i][1]), parent };
  }
  return parent!;
}

export function computeSelectionRanges(model: FileModel, positions: Position[]): SelectionRange[] {
  return positions.map((p) => computeSelectionRange(model, p));
}

export function register(ctx: ServerContext): void {
  ctx.connection.onFoldingRanges((params) => {
    try {
      const model = ctx.getModel(params.textDocument.uri);
      return model ? computeFoldingRanges(model) : [];
    } catch (err) {
      ctx.log.error(`foldingRanges failed: ${(err as Error).stack ?? err}`);
      return [];
    }
  });
  ctx.connection.onSelectionRanges((params) => {
    try {
      const model = ctx.getModel(params.textDocument.uri);
      return model ? computeSelectionRanges(model, params.positions) : [];
    } catch (err) {
      ctx.log.error(`selectionRanges failed: ${(err as Error).stack ?? err}`);
      return [];
    }
  });
}
