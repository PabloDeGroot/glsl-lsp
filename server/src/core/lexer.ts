// Tolerant GLSL lexer. Never throws: unknown characters become single-char
// punctuation tokens and unterminated comments/strings run to the end of the
// line or file. Comments are kept (they carry documentation) and every
// preprocessor line becomes a single `directive` token, which
// `directives.ts` dissects further.

export type TokenKind =
  | 'ident' // identifiers AND keywords; check keyword sets by text
  | 'number'
  | 'string'
  | 'punct'
  | 'lineComment'
  | 'blockComment'
  | 'directive';

export interface Token {
  kind: TokenKind;
  text: string;
  /** Absolute UTF-16 offset of the first character. */
  start: number;
  /** Absolute offset one past the last character. */
  end: number;
  /** Zero-based line of `start`. */
  line: number;
  /** Zero-based line of the last character. */
  endLine: number;
}

const PUNCT3 = new Set(['<<=', '>>=']);
const PUNCT2 = new Set([
  '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '^^',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##',
]);

export function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

export function isIdentPart(c: number): boolean {
  return isIdentStart(c) || (c >= 48 && c <= 57);
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

function isNumberSuffix(c: number): boolean {
  // u U f F l L
  return c === 117 || c === 85 || c === 102 || c === 70 || c === 108 || c === 76;
}

export interface LexOptions {
  /** Offset added to every token offset (used to sub-lex directive text). */
  baseOffset?: number;
  /** Line added to every token line. */
  baseLine?: number;
  /** When false, `#` lines are lexed as ordinary tokens. Default true. */
  directives?: boolean;
}

export function lex(text: string, options: LexOptions = {}): Token[] {
  const base = options.baseOffset ?? 0;
  const handleDirectives = options.directives ?? true;
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  let line = options.baseLine ?? 0;
  /** True while only whitespace has been seen on the current line. */
  let atLineStart = true;

  const push = (kind: TokenKind, start: number, end: number, startLine: number) => {
    tokens.push({ kind, text: text.slice(start, end), start: start + base, end: end + base, line: startLine, endLine: line });
  };

  /** Skips a block comment body starting at i (just after the opening). */
  const skipBlockComment = () => {
    while (i < n && !(text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47)) {
      const d = text.charCodeAt(i);
      if (d === 10 || (d === 13 && text.charCodeAt(i + 1) !== 10)) line++;
      i++;
    }
    i = Math.min(n, i + 2);
  };

  while (i < n) {
    const c = text.charCodeAt(i);

    // Newlines and whitespace.
    if (c === 10 || c === 13) {
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      i++;
      line++;
      atLineStart = true;
      continue;
    }
    if (c === 32 || c === 9 || c === 11 || c === 12) {
      i++;
      continue;
    }
    // Line continuation outside directives: skip the backslash.
    if (c === 92 /* \ */ && (text.charCodeAt(i + 1) === 10 || text.charCodeAt(i + 1) === 13)) {
      i++;
      continue;
    }

    const start = i;
    const startLine = line;

    // Comments.
    if (c === 47 /* / */ && text.charCodeAt(i + 1) === 47) {
      i += 2;
      while (i < n && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) i++;
      push('lineComment', start, i, startLine);
      atLineStart = false;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42 /* * */) {
      i += 2;
      skipBlockComment();
      push('blockComment', start, i, startLine);
      // A block comment does not end "line start" status: `/* x */ #define` is rare
      // but legal, so keep atLineStart unchanged.
      continue;
    }

    // Preprocessor directive: '#' first on its line, runs to end of line
    // (honouring backslash continuations and inline block comments), but a
    // trailing // comment is emitted as its own token.
    if (c === 35 /* # */ && atLineStart && handleDirectives) {
      i++;
      let end = i;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 10 || d === 13) {
          // Backslash continuation joins the next line.
          let k = end - 1;
          while (k > start && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k--;
          if (text.charCodeAt(k) === 92) {
            if (d === 13 && text.charCodeAt(i + 1) === 10) i++;
            i++;
            line++;
            end = i;
            continue;
          }
          break;
        }
        if (d === 47 && text.charCodeAt(i + 1) === 47) break;
        if (d === 47 && text.charCodeAt(i + 1) === 42) {
          i += 2;
          skipBlockComment();
          end = i;
          continue;
        }
        if (d === 34 /* " */) {
          i++;
          while (i < n && text.charCodeAt(i) !== 34 && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) i++;
          if (text.charCodeAt(i) === 34) i++;
          end = i;
          continue;
        }
        i++;
        if (d !== 32 && d !== 9) end = i;
      }
      push('directive', start, end, startLine);
      atLineStart = false;
      continue;
    }

    atLineStart = false;

    if (isIdentStart(c)) {
      i++;
      while (i < n && isIdentPart(text.charCodeAt(i))) i++;
      push('ident', start, i, startLine);
      continue;
    }

    if (isDigit(c) || (c === 46 /* . */ && isDigit(text.charCodeAt(i + 1)))) {
      if (c === 48 && (text.charCodeAt(i + 1) === 120 || text.charCodeAt(i + 1) === 88)) {
        i += 2;
        while (i < n && isHexDigit(text.charCodeAt(i))) i++;
      } else {
        while (i < n && isDigit(text.charCodeAt(i))) i++;
        if (text.charCodeAt(i) === 46) {
          i++;
          while (i < n && isDigit(text.charCodeAt(i))) i++;
        }
        const e = text.charCodeAt(i);
        if (e === 101 || e === 69) {
          const s = text.charCodeAt(i + 1);
          if (isDigit(s) || ((s === 43 || s === 45) && isDigit(text.charCodeAt(i + 2)))) {
            i += 2;
            while (i < n && isDigit(text.charCodeAt(i))) i++;
          }
        }
      }
      while (i < n && isNumberSuffix(text.charCodeAt(i))) i++;
      push('number', start, i, startLine);
      continue;
    }

    if (c === 34 /* " */) {
      i++;
      while (i < n && text.charCodeAt(i) !== 34 && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) i++;
      if (text.charCodeAt(i) === 34) i++;
      push('string', start, i, startLine);
      continue;
    }

    if (PUNCT3.has(text.substr(i, 3))) i += 3;
    else if (PUNCT2.has(text.substr(i, 2))) i += 2;
    else i++;
    push('punct', start, i, startLine);
  }
  return tokens;
}

export function isComment(t: Token): boolean {
  return t.kind === 'lineComment' || t.kind === 'blockComment';
}

/** Tokens the parser looks at: everything except comments and directives. */
export function isSignificant(t: Token): boolean {
  return t.kind !== 'lineComment' && t.kind !== 'blockComment' && t.kind !== 'directive';
}

/**
 * Index of the token whose span contains `offset` (end inclusive), or -1.
 * When the offset touches two tokens (`a|.b`) an identifier wins.
 */
export function tokenIndexAt(tokens: readonly Token[], offset: number): number {
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = tokens[mid];
    if (offset < t.start) hi = mid - 1;
    else if (offset > t.end) lo = mid + 1;
    else {
      if (offset === t.end && t.kind !== 'ident' && mid + 1 < tokens.length && tokens[mid + 1].start === offset) return mid + 1;
      if (offset === t.start && t.kind !== 'ident' && mid > 0 && tokens[mid - 1].end === offset && tokens[mid - 1].kind === 'ident') return mid - 1;
      return mid;
    }
  }
  return -1;
}
