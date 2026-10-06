// Intra-line spacing: decides the whitespace between two adjacent tokens on
// the same line. Conservative mode only ever adds a missing space (after `,`
// and `;`, around assignments); opinionated mode normalizes operators,
// keywords, parentheses and braces. Whitespace next to a comment is never
// touched here (trailing comments keep their column, see layout.ts).

import { lex, type Token } from '../../core/lexer';
import { isCommentToken, type Analysis } from './analyze';

const ASSIGNMENT = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
const BINARY = new Set([
  '*', '/', '%', '<', '>', '<=', '>=', '==', '!=', '&&', '||', '^^', '&', '|', '^', '<<', '>>', '?',
  ...ASSIGNMENT,
]);
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'return']);
/** Words that are never called, so `word (` keeps its space. */
const NOT_CALLABLE = new Set([
  'else', 'do', 'case', 'default', 'in', 'out', 'inout', 'uniform', 'const', 'attribute', 'varying', 'buffer', 'shared',
  'highp', 'mediump', 'lowp', 'flat', 'smooth', 'noperspective', 'centroid', 'invariant', 'precise', 'break', 'continue', 'discard',
]);

/** Whether `a` and `b` lex back to the same two tokens when written with no space between them. */
export function canJoin(a: Token, b: Token): boolean {
  const joined = lex(a.text + b.text, { directives: false });
  return joined.length === 2 && joined[0].text === a.text && joined[1].text === b.text;
}

/**
 * Conservative: the new gap, or undefined to keep `gap`. Only adds spaces.
 * `1.0,-2.0` keeps its comma: matrices align signed columns that way.
 */
export function conservativeGap(an: Analysis, ai: number, bi: number, gap: string): string | undefined {
  if (gap !== '') return undefined;
  const a = an.tokens[ai];
  const b = an.tokens[bi];
  if (isCommentToken(a) || isCommentToken(b)) return undefined;
  if (a.text === ',' && b.text !== ')' && b.text !== ']' && !an.unary.has(bi)) return ' ';
  if (a.text === ';' && b.text !== ';' && b.text !== ')' && b.text !== '}') return ' ';
  if (a.kind === 'punct' && ASSIGNMENT.has(a.text)) return ' ';
  if (b.kind === 'punct' && ASSIGNMENT.has(b.text)) return ' ';
  return undefined;
}

/** Opinionated: '' or ' ' to normalize the gap, undefined to keep it. `ai`/`bi` are token indices. */
export function opinionatedGap(an: Analysis, ai: number, bi: number): string | undefined {
  const a = an.tokens[ai];
  const b = an.tokens[bi];
  if (isCommentToken(a) || isCommentToken(b)) return undefined;
  const at = a.text;
  const bt = b.text;
  const aPunct = a.kind === 'punct';
  const bPunct = b.kind === 'punct';
  if (bPunct && (bt === ',' || bt === ';')) return '';
  if (aPunct && at === ',') return ' ';
  if (aPunct && at === ';') return bt === ')' ? '' : ' ';
  // One-line blocks: `{ x(); }` (an empty `{}` stays).
  if (aPunct && at === '{' && an.blockBrace.has(ai)) return bt === '}' ? undefined : ' ';
  if (bPunct && bt === '}' && an.blockBrace.has(bi)) return at === '{' ? undefined : ' ';
  if (aPunct && (at === '(' || at === '[')) return '';
  if (bPunct && (bt === ')' || bt === ']')) return '';
  if (at === '.' || bt === '.') return undefined;
  const incDec = at === '++' || at === '--' || bt === '++' || bt === '--';

  // Operators.
  const aColon = aPunct && at === ':';
  const bColon = bPunct && bt === ':';
  if (bColon && !an.ternaryColon.has(bi)) return ''; // case label
  if (aColon && !an.ternaryColon.has(ai)) return undefined;
  const aBinary = aPunct && (BINARY.has(at) || (aColon && an.ternaryColon.has(ai)) || ((at === '+' || at === '-') && !an.unary.has(ai)));
  const bBinary = bPunct && (BINARY.has(bt) || (bColon && an.ternaryColon.has(bi)) || ((bt === '+' || bt === '-') && !an.unary.has(bi)));
  // `a++ + b`, `a - --b`; otherwise `++`/`--` keep their spacing.
  if (incDec) return aBinary || bBinary ? ' ' : undefined;
  if (aBinary) return ' ';
  if (aPunct && (at === '!' || at === '~' || at === '+' || at === '-')) return '';
  if (bBinary) return ' ';

  if (bPunct && bt === '(') {
    if (a.kind === 'ident') return CONTROL.has(at) ? ' ' : NOT_CALLABLE.has(at) ? undefined : '';
    if (aPunct && at === ']') return '';
    return undefined;
  }
  if (bPunct && bt === '[' && (at === ')' || at === ']' || (a.kind === 'ident' && !CONTROL.has(at)))) return '';
  if (a.kind === 'ident' && CONTROL.has(at)) return ' ';
  if (bPunct && bt === '{') return aPunct && at === '{' ? undefined : ' ';
  if (aPunct && at === '}' && bt === 'else') return ' ';
  if (a.kind === 'ident' && at === 'else') return ' ';
  return undefined;
}
