import { describe, expect, it } from 'vitest';
import {
  computeFormatEdits,
  formatDocument,
  formatOnType,
  formatRange,
  formatText,
  resolveFormatOptions,
  type FormatSettings,
} from '../server/src/features/format/index';
import { applyEdits, conservativeViolation, fmt, invariantProblems } from './formatHelpers';

const L = (...lines: string[]) => lines.join('\n') + '\n';
const OPINIONATED: Partial<FormatSettings> = { mode: 'opinionated' };
const ALL_MODES: Partial<FormatSettings>[] = [
  { mode: 'conservative' },
  { mode: 'opinionated' },
  { mode: 'opinionated', braceStyle: 'sameLine' },
  { mode: 'opinionated', braceStyle: 'nextLine' },
];

/** Checks invariants 1 and 2 in every mode, and invariant 3 for conservative. */
function expectInvariants(text: string) {
  for (const s of ALL_MODES) expect(invariantProblems(text, s), JSON.stringify(s)).toEqual([]);
  expect(conservativeViolation(text, fmt(text))).toBeUndefined();
}

describe('format: conservative indentation', () => {
  it('re-indents by brace depth', () => {
    expect(fmt(L('void main() {', 'float a = 1.0;', '  if (a > 0.0) {', 'a = 2.0;', '        }', '}'))).toBe(
      L('void main() {', '    float a = 1.0;', '    if (a > 0.0) {', '        a = 2.0;', '    }', '}'),
    );
  });

  it('gives continuation lines one extra level, keeping deeper hand alignment', () => {
    const src = L(
      'void f() {',
      'float x = mix(a,',
      'b, t);',
      '  vec3 c = vec3(1.0,',
      '                2.0,',
      '                3.0);',
      '}',
    );
    expect(fmt(src)).toBe(
      L('void f() {', '    float x = mix(a,', '        b, t);', '    vec3 c = vec3(1.0,', '                  2.0,', '                  3.0);', '}'),
    );
  });

  it('a closing parenthesis line goes back to the statement level', () => {
    expect(fmt(L('void f() {', '    g(', '        a,', '        b', ');', '}'))).toBe(L('void f() {', '    g(', '        a,', '        b', '    );', '}'));
  });

  it('continues expressions after an operator or before a leading operator', () => {
    expect(fmt(L('void f() {', '    float x = a +', '    b;', '    float y = a', '    * b;', '}'))).toBe(
      L('void f() {', '    float x = a +', '        b;', '    float y = a', '        * b;', '}'),
    );
  });

  it('indents un-braced bodies and keeps stacked loops over one body flat', () => {
    expect(fmt(L('void f() {', 'if (a)', 'b = 1.0;', 'else', 'b = 2.0;', 'c = 3.0;', '}'))).toBe(
      L('void f() {', '    if (a)', '    b = 1.0;', '    else', '    b = 2.0;', '    c = 3.0;', '}'),
    );
    expect(fmt(L('void f() {', '    if (a)', '        b = 1.0;', '    c = 3.0;', '}'))).toBe(L('void f() {', '    if (a)', '        b = 1.0;', '    c = 3.0;', '}'));
    const loops = L('void f() {', '    for (int y = 0; y < 3; y++)', '    for (int x = 0; x < 3; x++) {', '        s += 1.0;', '    }', '}');
    expect(fmt(loops)).toBe(loops);
  });

  it('Allman braces and else chains', () => {
    const src = L('void f()', '{', 'if (a)', '{', 'x = 1;', '}', 'else if (b)', '{', 'x = 2;', '}', '}');
    expect(fmt(src)).toBe(L('void f()', '{', '    if (a)', '    {', '        x = 1;', '    }', '    else if (b)', '    {', '        x = 2;', '    }', '}'));
  });

  it('switch: case labels one level in, statements one more', () => {
    const src = L('void f() {', 'switch (i) {', 'case 0:', 'x = 1;', 'break;', 'default: {', 'x = 2;', '} break;', '}', '}');
    expect(fmt(src)).toBe(
      L('void f() {', '    switch (i) {', '        case 0:', '            x = 1;', '            break;', '        default: {', '            x = 2;', '        } break;', '    }', '}'),
    );
  });

  it('structs, initializer lists and array constructors', () => {
    const src = L('struct S {', 'float a;', '  vec3 b;', '};', 'const float K[3] = float[3](', '1.0,', '2.0,', '3.0', ');', 'float v[2] = { 1.0,', '               2.0 };');
    expect(fmt(src)).toBe(L('struct S {', '    float a;', '    vec3 b;', '};', 'const float K[3] = float[3](', '    1.0,', '    2.0,', '    3.0', ');', 'float v[2] = { 1.0,', '               2.0 };'));
  });

  it('comment lines follow the code; deeper comment lines (commented-out code) stay', () => {
    expect(fmt(L('void f() {', '// note', '    x = 1;', '        // deeper', '}'))).toBe(L('void f() {', '    // note', '    x = 1;', '        // deeper', '}'));
    // ... moving with the code when it is re-indented; opinionated mode indents them like code.
    expect(fmt(L('void f() {', 'x = 1;', '    // deeper', '}'))).toBe(L('void f() {', '    x = 1;', '        // deeper', '}'));
    expect(fmt(L('void f() {', 'x = 1;', '    // deeper', '}'), OPINIONATED)).toBe(L('void f() {', '    x = 1;', '    // deeper', '}'));
  });

  it('comment lines continuing an aligned trailing comment keep its column', () => {
    const src = L('const float a = 1.0;   // first part', '                       // second part', 'float b;');
    expect(fmt(src)).toBe(src);
    expect(fmt(src, OPINIONATED)).toBe(src);
  });

  it('block comment lines move with the comment start when that is safe', () => {
    expect(fmt(L('void f() {', '/* a', '   b */', 'x = 1;', '}'))).toBe(L('void f() {', '    /* a', '       b */', '    x = 1;', '}'));
    // A line indented less than the comment start: left alone.
    expect(fmt(L('void f() {', '  /* a', ' b */', 'x = 1;', '}'))).toBe(L('void f() {', '    /* a', ' b */', '    x = 1;', '}'));
  });

  it('tabs: indents with tabs when insertSpaces is false', () => {
    expect(fmt(L('void f() {', '    if (a) {', 'x = 1;', '    }', '}'), {}, { tabSize: 4, insertSpaces: false })).toBe(L('void f() {', '\tif (a) {', '\t\tx = 1;', '\t}', '}'));
    expect(fmt(L('void f() {', '\tx = 1;', '}'), {}, { tabSize: 2, insertSpaces: true })).toBe(L('void f() {', '  x = 1;', '}'));
  });

  it('broken (unbalanced) code keeps its indentation but still gets the other fixes', () => {
    const src = L('void f() {', '  x=1;   ', '  if (a) {');
    expect(fmt(src)).toBe(L('void f() {', '  x = 1;', '  if (a) {'));
    expect(fmt(L('}', '  x=1;'))).toBe(L('}', '  x = 1;'));
  });
});

describe('format: preprocessor', () => {
  it('leaves directives alone by default, code inside keeps brace depth', () => {
    const src = L('void f() {', '  #ifdef A', 'x = 1;', '    #endif', '}');
    expect(fmt(src)).toBe(L('void f() {', '  #ifdef A', '    x = 1;', '    #endif', '}'));
  });

  it('indentPreprocessor puts directives at the brace depth', () => {
    expect(fmt(L('void f() {', '#ifdef A', 'x = 1;', '#else', 'x = 2;', '#endif', '}'), { indentPreprocessor: true })).toBe(
      L('void f() {', '    #ifdef A', '    x = 1;', '    #else', '    x = 2;', '    #endif', '}'),
    );
  });

  it('#if branches that each open a brace keep the depth (LYGIA style)', () => {
    const src = L(
      '#ifndef FNC_FOO',
      '#define FNC_FOO',
      '#if defined(FOO_FAST)',
      'float foo(float x) {',
      '#else',
      'float foo(float x, float y) {',
      '#endif',
      'return x;',
      '}',
      'float bar() { return 1.0; }',
      '#endif',
    );
    expect(fmt(src)).toBe(
      L('#ifndef FNC_FOO', '#define FNC_FOO', '#if defined(FOO_FAST)', 'float foo(float x) {', '#else', 'float foo(float x, float y) {', '#endif', '    return x;', '}', 'float bar() { return 1.0; }', '#endif'),
    );
  });

  it('unbalanced branches: the first branch wins, resynchronized at #endif', () => {
    const src = L('void f() {', '#ifdef A', 'for (int i = 0; i < 2; i++) {', '#else', 'for (int i = 0; i < 4; i++) { if (b) {', '#endif', 'x += 1.0;', '}', '}');
    expect(fmt(src)).toBe(L('void f() {', '#ifdef A', '    for (int i = 0; i < 2; i++) {', '#else', '    for (int i = 0; i < 4; i++) { if (b) {', '#endif', '        x += 1.0;', '    }', '}'));
  });

  it('macro continuations, include guards and shader-toy directives are untouched', () => {
    const src = L(
      '#iUniform float u_speed = 1.0 in { 0.0, 4.0 }   ',
      '#iChannel0 "file://textures/noise.png"',
      '#define SQ(x)  ((x)*(x)) \\',
      '      + 0.0   \\',
      '  ',
      'float a=SQ(2.0);',
    );
    expect(fmt(src)).toBe(L('#iUniform float u_speed = 1.0 in { 0.0, 4.0 }', '#iChannel0 "file://textures/noise.png"', '#define SQ(x)  ((x)*(x)) \\', '      + 0.0   \\', '', 'float a = SQ(2.0);'));
  });

  it('a code line ending in a backslash is left as is', () => {
    const src = L('void f() {', '  x=1; \\', '}');
    expect(fmt(src)).toBe(src);
  });
});

describe('format: conservative spacing', () => {
  it('adds a space after , and ; and around assignments only', () => {
    expect(fmt(L('void f() {', '    x=vec2(1.0,2.0);y+=1;', '    for (int i=0;i<3;i++) {}', '    for (;;) {}', '}'))).toBe(
      L('void f() {', '    x = vec2(1.0, 2.0); y += 1;', '    for (int i = 0; i<3; i++) {}', '    for (;;) {}', '}'),
    );
  });

  it('never touches other intra-line spacing: hand-aligned columns survive', () => {
    const src = L(
      'void f() {',
      '    if (screenAspect > texAspect) scale.y = texAspect / screenAspect;',
      '    else                          scale.x = screenAspect / texAspect;',
      '    float a    = 1.0;   // aligned',
      '    float bcd  = 2.0;   // comments',
      '    vec2  e    = vec2( 1.0 ,2.0 );',
      '    mat2  m    = mat2( 1.0,-2.0,',
      '                      -3.0, 4.0);',
      '}',
    );
    expect(fmt(src)).toBe(src.replace('vec2( 1.0 ,2.0 )', 'vec2( 1.0 , 2.0 )'));
  });

  it('an aligned trailing comment keeps its column when code grows', () => {
    expect(fmt(L('float a=1.0;    // c', 'float bb = 2.0;  // d'))).toBe(L('float a = 1.0;  // c', 'float bb = 2.0;  // d'));
  });

  it('comment and string contents are never altered', () => {
    const src = L('// a=b,c;d', '/* x=y,z */', 'float a = 1.0; // q=r,s');
    expect(fmt(src)).toBe(src);
  });
});

describe('format: whitespace and lines', () => {
  it('trims trailing whitespace, collapses blank runs, fixes the final newline', () => {
    expect(fmt('float a;   \n\n\n\nfloat b;\t\n\n\n')).toBe('float a;\n\nfloat b;\n');
    expect(fmt('float a;')).toBe('float a;\n');
    expect(fmt('float a;\n\n\n\nfloat b;\n', { maxBlankLines: 2 })).toBe('float a;\n\n\nfloat b;\n');
    expect(fmt('float a;\n\n\nfloat b;\n', { maxBlankLines: 0 })).toBe('float a;\nfloat b;\n');
  });

  it('respects the LSP options that turn rules off', () => {
    const editor = { tabSize: 4, insertSpaces: true, trimTrailingWhitespace: false, insertFinalNewline: false, trimFinalNewlines: false };
    expect(fmt('float a;   \nfloat b;\n\n\n', {}, editor)).toBe('float a;   \nfloat b;\n\n');
    expect(fmt('float a;', {}, editor)).toBe('float a;');
  });

  it('keeps CRLF line breaks', () => {
    const src = 'void f() {\r\nx=1;  \r\n\r\n\r\n}';
    expect(fmt(src)).toBe('void f() {\r\n    x = 1;\r\n\r\n}\r\n');
    expect(fmt(src, OPINIONATED)).toBe('void f() {\r\n    x = 1;\r\n\r\n}\r\n');
    expect(fmt('void f()\r\n{\r\n}\r\n', { mode: 'opinionated', braceStyle: 'sameLine' })).toBe('void f() {\r\n}\r\n');
    expect(fmt('void f() {\r\n}\r\n', { mode: 'opinionated', braceStyle: 'nextLine' })).toBe('void f()\r\n{\r\n}\r\n');
  });

  it('format-off regions are left exactly as they are', () => {
    const src = L('void f() {', '// glsl-format off', 'x=1;   ', '', '', '', '  mat2 m = mat2(1,0,', '                0,1);', '// glsl-format on', 'y=2;', '}');
    expect(fmt(src)).toBe(L('void f() {', '// glsl-format off', 'x=1;   ', '', '', '', '  mat2 m = mat2(1,0,', '                0,1);', '// glsl-format on', '    y = 2;', '}'));
    expect(fmt(src, { mode: 'opinionated', braceStyle: 'nextLine' })).toContain('x=1;   \n\n\n\n  mat2 m = mat2(1,0,');
  });

  it('mode off changes nothing', () => {
    expect(fmt('void f(){x=1;   }', { mode: 'off' })).toBe('void f(){x=1;   }');
  });

  it('already formatted conservative input gives no edits', () => {
    const src = L('#version 300 es', 'precision highp float;', '', 'uniform vec2 iResolution;', '', 'vec3 palette(float t) {', '    return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));', '}', '', 'void main() {', '    vec2 uv = gl_FragCoord.xy / iResolution;', '    for (int i = 0; i < 3; i++) {', '        uv = fract(uv * 1.5) - 0.5;', '    }', '}');
    expect(computeFormatEdits(src, resolveFormatOptions({ tabSize: 4, insertSpaces: true }, {}))).toEqual([]);
  });
});

describe('format: opinionated', () => {
  const op = (t: string, s: Partial<FormatSettings> = {}) => fmt(t, { mode: 'opinionated', ...s });

  it('spaces binary operators but not unary signs, exponents or ++/--', () => {
    expect(op(L('void f() {', '    x=a+b*-c/(d-1e-3)  ;', '    i++;--j;', '    y = -x + +z - !w;', '    return-x;', '}'))).toBe(
      L('void f() {', '    x = a + b * -c / (d - 1e-3);', '    i++; --j;', '    y = -x + +z - !w;', '    return -x;', '}'),
    );
  });

  it('keywords, calls, parentheses, brackets, ternaries and labels', () => {
    expect(op(L('void main () {', '    if(a){b = foo ( 1.0 , 2.0 );}', '    while( c [ 0 ] >0 ) c[0]-=1;', '    float t = a?b:c;', '    switch(i){case 1 : break;}', '}'))).toBe(
      L('void main() {', '    if (a) { b = foo(1.0, 2.0); }', '    while (c[0] > 0) c[0] -= 1;', '    float t = a ? b : c;', '    switch (i) { case 1: break; }', '}'),
    );
  });

  it('single space before { and joined else per brace style', () => {
    expect(op(L('void f()   {', '    if (a)  {', '    }', '    else  {', '    }', '}'))).toBe(L('void f() {', '    if (a) {', '    }', '    else {', '    }', '}'));
    expect(op(L('void f()', '{', '    if (a)', '    {', '    }', '    else', '    {', '    }', '}'), { braceStyle: 'sameLine' })).toBe(
      L('void f() {', '    if (a) {', '    } else {', '    }', '}'),
    );
    expect(op(L('void f() {', '    if (a) {', '    } else if (b) { // why', '    }', '}'), { braceStyle: 'nextLine' })).toBe(
      L('void f()', '{', '    if (a)', '    {', '    }', '    else if (b)', '    { // why', '    }', '}'),
    );
  });

  it('brace moves never cross comments, directives, blank lines or initializer lists', () => {
    const src = L('void f() // doc', '{', '}', '#ifdef A', 'void g()', '#else', 'void g(int x)', '#endif', '{', '}', 'float v[2] = float[2](', '    1.0, 2.0);', 'void h()', '', '{', '}');
    expect(op(src, { braceStyle: 'sameLine' })).toBe(src);
    const one = L('float g() { return 1.0; }', 'float k[2] = { 1.0, 2.0 };');
    expect(op(one, { braceStyle: 'nextLine' })).toBe(one);
  });

  it('keeps hand-aligned trailing comments in their column', () => {
    expect(op(L('float a=1.0;     // c', 'float bb = 2.0;  // d'))).toBe(L('float a = 1.0;   // c', 'float bb = 2.0;  // d'));
  });

  it('never joins tokens into different ones', () => {
    expect(op(L('void f() {', '    x = - -y;', '    z = a - - b;', '}'))).toBe(L('void f() {', '    x = - -y;', '    z = a - -b;', '}'));
  });
});

describe('format: invariants on fixtures', () => {
  const fixtures: Record<string, string> = {
    lygiaStyle: L(
      '/*',
      'contributors: someone',
      'description: test',
      'use: <float> foo(<float> x)',
      'options:',
      '    - FOO_FAST',
      '*/',
      '',
      '#ifndef FNC_FOO',
      '#define FNC_FOO',
      '#if defined(FOO_FAST)',
      'float foo(float x) {',
      '#else',
      'float foo(float x){',
      '#endif',
      '    #ifdef FOO_EXTRA',
      '    x+=1.0;',
      '    #endif',
      '  return x*x;',
      '}',
      '#endif',
    ),
    shadertoy: L(
      '#iChannel0 "file://a.png"',
      '#iUniform float u = 1.0 in { 0.0, 4.0 }',
      'void mainImage( out vec4 fragColor, in vec2 fragCoord ){',
      '    vec2 uv=fragCoord/iResolution.xy;',
      '    fragColor=vec4(uv,0.5+0.5*sin(iTime),1.0);',
      '}',
    ),
    weird: L('float f(){return a?b:-c;}', 'void g() {', '  x = (', '    a,', '  b);', '  y=a++ + ++b;', '  z = a---b;', '}', 'int k[]={1,2,', '3};'),
    halfTyped: L('void main() {', '    vec3 col = mix(a,', '    if (x', '    float y = ', '/* open comment'),
    mixedEols: 'void f() {\r\nx=1;\ny=2;\r\n}',
    tabs: '\tfloat a;\n\t\tvoid f() {\n\t\t\tx=1;\n}\n',
    formatOff: L('// glsl-format off', 'x=1;', '/* glsl-format on */', 'y=1;', '// glsl-format off', 'z=1;'),
    empty: '',
    onlyBlank: '\n\n\n',
  };
  for (const [name, text] of Object.entries(fixtures)) {
    it(name, () => expectInvariants(text));
  }

  it('never throws on random garbage', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ['{', '}', '(', ')', '[', ']', ';', ',', '=', '-', '+', '*', '/', '/*', '*/', '//', '#if A', '#else', '#endif', '\n', '\r\n', ' ', '\t', 'x', '1.0', 'if', 'else', '"s"', '\\', ':', '?'];
    for (let k = 0; k < 200; k++) {
      let t = '';
      for (let i = 0; i < 60; i++) t += alphabet[Math.floor(rnd() * alphabet.length)];
      for (const s of ALL_MODES) {
        expect(() => formatDocument(t, { tabSize: 4, insertSpaces: true }, s)).not.toThrow();
        expect(invariantProblems(t, s), JSON.stringify(t)).toEqual([]);
      }
    }
  });
});

describe('format: range and on-type', () => {
  const editor = { tabSize: 4, insertSpaces: true };
  const src = L('void f() {', 'x=1;', '    if (a) {', 'y=2;', '}', 'z=3;', '}');

  it('range formatting changes only whole lines in the range, with the depth from the document', () => {
    const edits = formatRange(src, { start: { line: 3, character: 2 }, end: { line: 3, character: 3 } }, editor, {});
    expect(applyEdits(src, edits)).toBe(L('void f() {', 'x=1;', '    if (a) {', '        y = 2;', '}', 'z=3;', '}'));
    // A selection ending at column 0 of the next line does not include that line.
    const edits2 = formatRange(src, { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, editor, {});
    expect(applyEdits(src, edits2)).toBe(L('void f() {', '    x = 1;', '    if (a) {', 'y=2;', '}', 'z=3;', '}'));
  });

  it('range formatting never applies half a brace move', () => {
    const t = L('void f()', '{', '}');
    const edits = formatRange(t, { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, editor, { mode: 'opinionated', braceStyle: 'sameLine' });
    expect(edits).toEqual([]);
    const all = formatRange(t, { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }, editor, { mode: 'opinionated', braceStyle: 'sameLine' });
    expect(applyEdits(t, all)).toBe(L('void f() {', '}'));
  });

  it('returns minimal edits, not a whole-document replacement', () => {
    const edits = formatDocument(L('void f() {', '    x=1;', '    y = 2;', '}'), editor, {});
    expect(edits).toEqual([{ range: { start: { line: 1, character: 5 }, end: { line: 1, character: 6 } }, newText: ' = ' }]);
    expect(applyEdits(L('void f() {', '    x=1;', '    y = 2;', '}'), edits)).toBe(L('void f() {', '    x = 1;', '    y = 2;', '}'));
    expect(edits.every((e) => e.range.start.line === 1 && e.range.end.line === 1)).toBe(true);
  });

  it("on type '}' re-indents the closing line only", () => {
    const t = L('void f() {', '    if (a) {', '        x=1;', '        }', 'y=2;');
    const edits = formatOnType(t, { line: 3, character: 9 }, '}', editor, {});
    expect(applyEdits(t, edits)).toBe(L('void f() {', '    if (a) {', '        x=1;', '    }', 'y=2;'));
  });

  it("on type ';' and new line re-indent the current line", () => {
    const t = L('void f() {', '    if (a) {', 'x=1;');
    expect(applyEdits(t, formatOnType(t, { line: 2, character: 4 }, ';', editor, {}))).toBe(L('void f() {', '    if (a) {', '        x=1;'));
    const t2 = L('void f() {', '    if (a) {', '', '    }', '}');
    expect(applyEdits(t2, formatOnType(t2, { line: 2, character: 0 }, '\n', editor, {}))).toBe(L('void f() {', '    if (a) {', '        ', '    }', '}'));
    expect(formatOnType(t2, { line: 2, character: 0 }, '\n', editor, { mode: 'off' })).toEqual([]);
    expect(formatOnType(t2, { line: 2, character: 0 }, 'x', editor, {})).toEqual([]);
  });

  it('on type leaves directives and format-off lines alone', () => {
    const t = L('void f() {', '#ifdef A', '// glsl-format off', 'x=1;', '}');
    expect(formatOnType(t, { line: 1, character: 8 }, '\n', editor, {})).toEqual([]);
    expect(formatOnType(t, { line: 3, character: 4 }, ';', editor, {})).toEqual([]);
  });
});

describe('format: regressions', () => {
  it('an `#if 0` branch with unbalanced brackets does not disable indentation', () => {
    expect(fmt('void f() {\n#if 0\n    if (a) {\n#endif\n  x();\n}\nvoid g() {\ny();\n}\n')).toBe(
      'void f() {\n#if 0\n    if (a) {\n#endif\n    x();\n}\nvoid g() {\n    y();\n}\n',
    );
    // Prose inside `#if 0` is left exactly as it is.
    expect(fmt("#if 0\nthis isn't code { (\n  a=b,c\n#endif\nvoid g() {\ny();\n}")).toBe("#if 0\nthis isn't code { (\n  a=b,c\n#endif\nvoid g() {\n    y();\n}\n");
    expect(fmt('#if false\n{\n#elif (0)\n(\n#else\nvoid g() {\n#endif\ny();\n}\n')).toBe('#if false\n{\n#elif (0)\n(\n#else\nvoid g() {\n#endif\n    y();\n}\n');
    expectInvariants('void f() {\n#if 0\n    if (a) {\n#endif\n  x();\n}\n');
  });

  it('a lone #ifdef branch that changes the depth is undone at #endif', () => {
    expect(fmt('void f() {\n#ifdef A\nif (a) {\n#endif\nx();\n#ifdef A\n}\n#endif\n}\nvoid g() {\ny();\n}\n')).toBe(
      // The second group's `}` is read against the depth before the first group.
      'void f() {\n#ifdef A\n    if (a) {\n#endif\n    x();\n#ifdef A\n}\n#endif\n}\nvoid g() {\n    y();\n}\n',
    );
  });

  it('aligned trailing comments keep their absolute column when a line is re-indented', () => {
    const src = L('void f() {', '    a = 1;     // x', '   bb = 2;     // y', '}');
    expect(fmt(src)).toBe(L('void f() {', '    a = 1;     // x', '    bb = 2;    // y', '}'));
    expect(fmt(src, OPINIONATED)).toBe(L('void f() {', '    a = 1;     // x', '    bb = 2;    // y', '}'));
    // Not possible (the code would reach the column): relative column, at least one space.
    expect(fmt(L('void f() {', 'a = 1;// x', 'bbbbbb = 2; // y', '}'))).toBe(L('void f() {', '    a = 1;// x', '    bbbbbb = 2; // y', '}'));
    // A comment line continuing it stays in that column.
    expect(fmt(L('void f() {', '  a = 1;    // x', '            // more', '}'))).toBe(L('void f() {', '    a = 1;  // x', '            // more', '}'));
  });

  it('no space is added between `;` and `}`; opinionated pads one-line blocks', () => {
    expect(fmt('void f() {return;}\n')).toBe('void f() {return;}\n');
    expect(fmt('void f() {x();}\nvoid g() {}\nfloat k[2] = {1.0, 2.0};\n', OPINIONATED)).toBe('void f() { x(); }\nvoid g() {}\nfloat k[2] = {1.0, 2.0};\n');
  });

  it('opinionated: binary operators after postfix ++/-- are spaced on both sides', () => {
    expect(fmt(L('void f() {', '    x = a--+b;', '    y = a++-b;', '    z = a+++b;', '    w = a - --b;', '}'), OPINIONATED)).toBe(
      L('void f() {', '    x = a-- + b;', '    y = a++ - b;', '    z = a++ + b;', '    w = a - --b;', '}'),
    );
  });

  it('backslash continuations: comment lines and whole code groups are left alone', () => {
    const comment = L('void f() {', '// note \\', 'x=1; { (', 'y=2;', '}');
    expect(fmt(comment)).toBe(L('void f() {', '// note \\', 'x=1; { (', '    y = 2;', '}'));
    const code = L('void f() {', 'float a=1.0 + \\', '2.0  ;  ', 'b=1;', '}');
    expect(fmt(code)).toBe(L('void f() {', 'float a=1.0 + \\', '2.0  ;  ', '    b = 1;', '}'));
    expectInvariants(comment);
    expectInvariants(code);
  });

  it('opinionated indents un-braced bodies one level; conservative keeps stacked loops flat', () => {
    const src = L('void f() {', '    if (a)', '    b();', '    else', '    e();', '    for (int i = 0; i < 2; i++)', '    x();', '    do', '    x++;', '    while (x < 3);', '}');
    expect(fmt(src, OPINIONATED)).toBe(
      L('void f() {', '    if (a)', '        b();', '    else', '        e();', '    for (int i = 0; i < 2; i++)', '        x();', '    do', '        x++;', '    while (x < 3);', '}'),
    );
    expect(fmt(src)).toBe(src);
  });
});

describe('format: README examples', () => {
  it('opinionated example', () => {
    expect(fmt(L('float f(float x){', 'return x*x+-1.0*sin (x) ;', '}'), OPINIONATED)).toBe(L('float f(float x) {', '    return x * x + -1.0 * sin(x);', '}'));
  });
  it('aligned continuation and format-off examples are left alone', () => {
    const src = L(
      'void f() {',
      '    vec3 c = mix(a,          // stays aligned under `a`',
      '                 b, t);',
      '}',
      '// glsl-format off',
      'const mat3 M = mat3( 0.00,  0.80,  0.60,',
      '                    -0.80,  0.36, -0.48,',
      '                    -0.60, -0.48,  0.64);',
      '// glsl-format on',
    );
    expect(fmt(src)).toBe(src);
  });
});

describe('format: whole-text helper', () => {
  it('formatText with mode off returns the input', () => {
    expect(formatText('x=1;', resolveFormatOptions({}, { mode: 'off' }))).toBe('x=1;');
  });
});
