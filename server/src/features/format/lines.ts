// Line splitting and indentation-width helpers. Line numbering matches the
// core lexer: `\r\n`, `\n` and a lone `\r` each end a line.

export interface SourceLine {
  /** Line content without its line break. */
  text: string;
  /** The line break that ends it ('' for a last line without one). */
  eol: string;
  /** Offset of the first character in the document. */
  start: number;
}

/** Splits `text` into lines. A text ending in a line break has no extra empty last line; '' has no lines. */
export function splitLines(text: string): SourceLine[] {
  const out: SourceLine[] = [];
  let start = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) {
      const eol = c === 13 && text.charCodeAt(i + 1) === 10 ? '\r\n' : c === 13 ? '\r' : '\n';
      out.push({ text: text.slice(start, i), eol, start });
      i += eol.length - 1;
      start = i + 1;
    }
  }
  if (start < n) out.push({ text: text.slice(start), eol: '', start });
  return out;
}

/** The document's line break: the first one found, else '\n'. */
export function detectEol(text: string): string {
  const m = /\r\n|\n|\r/.exec(text);
  return m ? m[0] : '\n';
}

export function leadingWhitespace(s: string): string {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  return s.slice(0, i);
}

export function trailingWhitespaceStart(s: string): number {
  let i = s.length;
  while (i > 0 && /\s/.test(s[i - 1])) i--;
  return i;
}

/** Visual width of leading whitespace (tabs advance to the next tab stop). */
export function visualWidth(ws: string, tabSize: number): number {
  let w = 0;
  for (const ch of ws) w = ch === '\t' ? (Math.floor(w / tabSize) + 1) * tabSize : w + 1;
  return w;
}

/** Whitespace of the given visual width: spaces, or tabs then spaces for the remainder. */
export function makeIndent(width: number, insertSpaces: boolean, tabSize: number): string {
  const w = Math.max(0, width);
  if (insertSpaces) return ' '.repeat(w);
  return '\t'.repeat(Math.floor(w / tabSize)) + ' '.repeat(w % tabSize);
}
