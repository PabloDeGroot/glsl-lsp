// Position utilities. Structurally identical to the LSP Position/Range types,
// so values flow straight into vscode-languageserver without conversion, but
// this module has no dependency on any VS Code package.

/** Zero-based line and UTF-16 character offset, like LSP. */
export interface Position {
  line: number;
  character: number;
}

/** Half-open range [start, end), like LSP. */
export interface Range {
  start: Position;
  end: Position;
}

/** Maps between absolute UTF-16 offsets and line/character positions. */
export class LineIndex {
  /** Offset of the first character of every line. */
  readonly lineStarts: number[];

  constructor(readonly text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 /* \n */) starts.push(i + 1);
      else if (c === 13 /* \r */) {
        if (text.charCodeAt(i + 1) === 10) i++;
        starts.push(i + 1);
      }
    }
    this.lineStarts = starts;
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  /** Line containing `offset` (binary search). */
  lineAt(offset: number): number {
    const starts = this.lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  positionAt(offset: number): Position {
    offset = Math.max(0, Math.min(offset, this.text.length));
    const line = this.lineAt(offset);
    return { line, character: offset - this.lineStarts[line] };
  }

  offsetAt(position: Position): number {
    if (position.line < 0) return 0;
    if (position.line >= this.lineStarts.length) return this.text.length;
    const start = this.lineStarts[position.line];
    const end = this.lineEnd(position.line);
    return Math.min(start + Math.max(0, position.character), end);
  }

  /** Offset of the end of `line`, excluding the line break. */
  lineEnd(line: number): number {
    if (line + 1 >= this.lineStarts.length) return this.text.length;
    let end = this.lineStarts[line + 1];
    const text = this.text;
    if (end > 0 && text.charCodeAt(end - 1) === 10) end--;
    if (end > 0 && text.charCodeAt(end - 1) === 13) end--;
    return end;
  }

  lineText(line: number): string {
    return this.text.slice(this.lineStarts[line] ?? this.text.length, this.lineEnd(line));
  }

  range(start: number, end: number): Range {
    return { start: this.positionAt(start), end: this.positionAt(end) };
  }
}

export function comparePositions(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}

/** True when `pos` lies within `range`, both ends inclusive (cursor-friendly). */
export function rangeContains(range: Range, pos: Position): boolean {
  return comparePositions(range.start, pos) <= 0 && comparePositions(pos, range.end) <= 0;
}

export function rangeContainsRange(outer: Range, inner: Range): boolean {
  return comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
}

export function rangesEqual(a: Range, b: Range): boolean {
  return comparePositions(a.start, b.start) === 0 && comparePositions(a.end, b.end) === 0;
}

export function emptyRange(pos: Position): Range {
  return { start: pos, end: pos };
}
