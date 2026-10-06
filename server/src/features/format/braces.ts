// Opinionated brace placement (glslLsp.format.braceStyle):
//   sameLine  `void f()\n{` -> `void f() {`, `}\nelse` -> `} else`
//   nextLine  `void f() {` -> `void f()\n{`, `} else {` -> `}\nelse\n{`
// Only block braces move (never initializer lists), only between ordinary
// code lines (never across a preprocessor line, a comment-only line, a blank
// line or a format-off region), and one-line blocks `{ return x; }` stay.
// Every output line remembers the original lines it came from, so edits can
// be computed per group of original lines.

import type { Token } from '../../core/lexer';
import { isCodeToken, type Analysis } from './analyze';
import type { BraceStyle } from './options';

export interface PlacedLine {
  text: string;
  eol: string;
  /** First and last original line this line was built from. */
  from: number;
  to: number;
}

interface Tail {
  /** Line may take part in a move. */
  movable: boolean;
  /** Last token on the line, when it is a code token. */
  lastCode: Token | undefined;
}

export function placeBraces(an: Analysis, style: BraceStyle, docEol: string): PlacedLine[] {
  const { lines, tokens } = an;
  const out: PlacedLine[] = [];
  const tails: Tail[] = [];

  const movable = (l: number): boolean => {
    if (an.kind[l] !== 'code' || an.off[l] || an.continued[l]) return false;
    const { lo, hi } = an.lineTokens[l];
    return hi > lo && tokens[hi - 1].endLine === l;
  };
  const tailOf = (l: number): Tail => {
    const { hi } = an.lineTokens[l];
    const last = tokens[hi - 1];
    const code = last && isCodeToken(last) ? last : undefined;
    return { movable: movable(l), lastCode: code };
  };

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    const { lo, hi } = an.lineTokens[l];
    const canMove = style !== 'preserve' && movable(l);

    if (canMove && style === 'sameLine' && out.length) {
      const prev = out[out.length - 1];
      const tail = tails[tails.length - 1];
      const first = tokens[lo];
      const prevText = tail.lastCode?.text;
      const loneBrace =
        first.text === '{' && an.blockBrace.has(lo) && (hi - lo === 1 || (hi - lo === 2 && tokens[lo + 1].kind === 'lineComment'));
      const header = loneBrace && tail.movable && !!tail.lastCode && prevText !== '{' && prevText !== '}' && prevText !== ';';
      const elseAfterBrace = first.text === 'else' && tail.movable && prevText === '}';
      if (header || elseAfterBrace) {
        prev.text = prev.text.replace(/\s+$/, '') + ' ' + line.text.replace(/^\s+/, '');
        prev.eol = line.eol;
        prev.to = l;
        tails[tails.length - 1] = tailOf(l);
        continue;
      }
    }

    if (canMove && style === 'nextLine') {
      const splits: number[] = [];
      if (tokens[lo].text === '}' && lo + 1 < hi && tokens[lo + 1].text === 'else') splits.push(lo + 1);
      let lc = hi - 1;
      while (lc > lo && !isCodeToken(tokens[lc])) lc--;
      if (lc > lo && tokens[lc].text === '{' && an.blockBrace.has(lc) && !splits.includes(lc)) splits.push(lc);
      // A line must never end up ending in a backslash (that would join it with the next one).
      for (let k = splits.length - 1; k >= 0; k--) if (tokens[splits[k] - 1]?.text === '\\') splits.splice(k, 1);
      if (splits.length) {
        const cuts = [0, ...splits.map((i) => tokens[i].start - line.start), line.text.length];
        for (let k = 0; k + 1 < cuts.length; k++) {
          const last = k + 2 === cuts.length;
          const seg = line.text.slice(cuts[k], cuts[k + 1]);
          out.push({ text: last ? seg : seg.replace(/\s+$/, ''), eol: last ? line.eol : line.eol || docEol, from: l, to: l });
          tails.push({ movable: false, lastCode: undefined });
        }
        continue;
      }
    }

    out.push({ text: line.text, eol: line.eol, from: l, to: l });
    tails.push(an.kind[l] === 'code' ? tailOf(l) : { movable: false, lastCode: undefined });
  }
  return out;
}
