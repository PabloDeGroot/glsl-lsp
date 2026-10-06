import { describe, expect, it } from 'vitest';
import { LineIndex, lex, tokenIndexAt } from '../server/src/core';

describe('lexer', () => {
  it('tokenizes identifiers, numbers, operators and strings', () => {
    const toks = lex('vec3 a = 1.5e-3 + .5f * 0x1Fu; a <<= 2; "s"');
    expect(toks.map((t) => [t.kind, t.text])).toEqual([
      ['ident', 'vec3'],
      ['ident', 'a'],
      ['punct', '='],
      ['number', '1.5e-3'],
      ['punct', '+'],
      ['number', '.5f'],
      ['punct', '*'],
      ['number', '0x1Fu'],
      ['punct', ';'],
      ['ident', 'a'],
      ['punct', '<<='],
      ['number', '2'],
      ['punct', ';'],
      ['string', '"s"'],
    ]);
  });

  it('keeps comments and tracks lines', () => {
    const toks = lex('// a\n/* b\n c */ x // d\r\ny');
    expect(toks.map((t) => [t.kind, t.line, t.endLine])).toEqual([
      ['lineComment', 0, 0],
      ['blockComment', 1, 2],
      ['ident', 2, 2],
      ['lineComment', 2, 2],
      ['ident', 3, 3],
    ]);
  });

  it('emits whole preprocessor lines, with continuations, and splits trailing // comments', () => {
    const toks = lex('#define F(x) \\\n  (x * 2.0) // twice\nfloat y;\n  #include "a.glsl"');
    expect(toks[0].kind).toBe('directive');
    expect(toks[0].text).toBe('#define F(x) \\\n  (x * 2.0)');
    expect(toks[1]).toMatchObject({ kind: 'lineComment', text: '// twice', line: 1 });
    expect(toks[2]).toMatchObject({ kind: 'ident', text: 'float', line: 2 });
    expect(toks.at(-1)).toMatchObject({ kind: 'directive', text: '#include "a.glsl"', line: 3 });
  });

  it('only treats # as a directive at line start', () => {
    const toks = lex('a # b');
    expect(toks.map((t) => t.kind)).toEqual(['ident', 'punct', 'ident']);
  });

  it('survives unterminated comments and strings', () => {
    expect(() => lex('/* never closed')).not.toThrow();
    expect(lex('"abc\nx').map((t) => t.kind)).toEqual(['string', 'ident']);
  });

  it('finds the token at an offset, preferring identifiers at boundaries', () => {
    const text = 'a.bc(d)';
    const toks = lex(text);
    expect(toks[tokenIndexAt(toks, 1)].text).toBe('a'); // between 'a' and '.'
    expect(toks[tokenIndexAt(toks, 3)].text).toBe('bc');
    expect(toks[tokenIndexAt(toks, 4)].text).toBe('bc'); // between 'bc' and '('
  });
});

describe('LineIndex', () => {
  it('converts offsets and positions with mixed line endings', () => {
    const li = new LineIndex('ab\r\ncd\ne');
    expect(li.lineCount).toBe(3);
    expect(li.positionAt(4)).toEqual({ line: 1, character: 0 });
    expect(li.offsetAt({ line: 2, character: 0 })).toBe(7);
    expect(li.offsetAt({ line: 0, character: 99 })).toBe(2);
    expect(li.lineText(1)).toBe('cd');
  });
});
