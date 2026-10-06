import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver/node';
import { describe, expect, it } from 'vitest';
import { resolveCompletionItem } from '../server/src/features/completion';
import { analyzeContext } from '../server/src/features/completion/context';
import { matchScore } from '../server/src/features/completion/identifiers';
import { swizzleItems } from '../server/src/features/completion/members';
import { applyEdits, complete, find, itemsOf, labels } from './completionHelpers';
import { cursor, parseText } from './helpers';

const MAIN_HEAD = '#include "lib/common.glsl"\n\n';

describe('completion context', () => {
  const ctxAt = (s: string) => {
    const { text, offset } = cursor(s);
    return analyzeContext(parseText(text), offset);
  };
  it('classifies positions', () => {
    expect(ctxAt('// hello wo|').kind).toBe('none');
    expect(ctxAt('/* a |*/').kind).toBe('none');
    expect(ctxAt('/* a */ x|').kind).toBe('identifier');
    expect(ctxAt('#inc|').kind).toBe('directiveName');
    expect(ctxAt('  #|').kind).toBe('directiveName');
    expect(ctxAt('#include "lib/|"')).toMatchObject({ kind: 'includePath', typed: 'lib/', hasClosingQuote: true });
    expect(ctxAt('#include <a|')).toMatchObject({ kind: 'includePath', typed: 'a', quote: '<', hasClosingQuote: false });
    expect(ctxAt('#ifdef FO|').kind).toBe('macroName');
    expect(ctxAt('#if defined(FO|').kind).toBe('macroName');
    expect(ctxAt('#version |').kind).toBe('version');
    expect(ctxAt('#define X(a) a + sat|')).toMatchObject({ kind: 'identifier', inDirective: true, word: 'sat' });
    expect(ctxAt('#define X|').kind).toBe('none');
    expect(ctxAt('float f = 1.|').kind).toBe('none');
    expect(ctxAt('v.xy|')).toMatchObject({ kind: 'member', word: 'xy' });
    expect(ctxAt('f(a).|')).toMatchObject({ kind: 'member', word: '' });
    expect(ctxAt('#define LONG a \\\n  b + c|')).toMatchObject({ kind: 'identifier', inDirective: true });
  });
});

describe('identifier completion', () => {
  const SRC = MAIN_HEAD + 'float helper(float a) { return a; }\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  float localVal = 1.0;\n  |\n}\n';

  it('offers locals, params, file and included symbols, builtins and keywords', () => {
    const { result } = complete(SRC);
    const ls = labels(result);
    for (const l of ['localVal', 'fragCoord', 'fragColor', 'helper', 'uvCentered', 'PI', 'mix', 'iTime', 'vec3', 'for', 'return']) expect(ls).toContain(l);
    expect(ls).not.toContain('mainImage');
    expect(ls).not.toContain('FNC_GNOISE');
  });

  it('ranks locals > file > included > builtins', () => {
    const { result } = complete(SRC);
    const st = (l: string) => find(result, l)!.sortText!;
    expect(st('localVal') < st('helper')).toBe(true);
    expect(st('helper') < st('uvCentered')).toBe(true);
    expect(st('uvCentered') < st('mix')).toBe(true);
    expect(st('mix') < st('vec3')).toBe(true);
  });

  it('uses proper kinds and details', () => {
    const { result } = complete(SRC);
    expect(find(result, 'helper')).toMatchObject({ kind: CompletionItemKind.Function, detail: 'float helper(float a)' });
    expect(find(result, 'uvCentered')!.labelDetails).toMatchObject({ detail: '(vec2 fragCoord, vec2 res)', description: 'lib/common.glsl' });
    expect(find(result, 'PI')!.kind).toBe(CompletionItemKind.Constant);
    expect(find(result, 'localVal')!.kind).toBe(CompletionItemKind.Variable);
    expect(find(result, 'for')!.kind).toBe(CompletionItemKind.Keyword);
  });

  it('offers entry-point snippets at file scope only', () => {
    const top = find(complete('mainIm|').result, 'mainImage');
    if (top) expect(top.insertText).toContain('void mainImage(');
    expect(find(complete(SRC).result, 'mainImage')).toBeUndefined();
  });

  it('only offers locals declared before the cursor', () => {
    const { result } = complete('void f() {\n  |\n  float later = 1.0;\n}\n');
    expect(labels(result)).not.toContain('later');
  });

  it('inserts function calls as snippets that trigger signature help', () => {
    const { result } = complete(SRC);
    const helper = find(result, 'helper')!;
    expect(helper.insertText).toBe('helper($0)');
    expect(helper.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(helper.command?.command).toBe('editor.action.triggerParameterHints');
  });

  it('inserts plain names without snippet support or before an existing (', () => {
    expect(find(complete(SRC, { snippetSupport: false }).result, 'helper')!.insertText).toBeUndefined();
    const { result } = complete(MAIN_HEAD + 'float helper(float a) { return a; }\nvoid f() { hel|(1.0); }\n');
    expect(find(result, 'helper')!.insertText).toBeUndefined();
  });

  it('returns nothing inside comments, after numbers and on division triggers', () => {
    expect(complete('void f() { // sat|\n}').result).toBeNull();
    expect(complete('void f() { float x = 1.|; }', { triggerCharacter: '.' }).result).toBeNull();
    expect(complete('void f() { float x = a /| }', { triggerCharacter: '/' }).result).toBeNull();
  });

  it('resolves documentation lazily', () => {
    const { result, ws } = complete(SRC);
    const item = find(result, 'uvCentered')!;
    expect(item.documentation).toBeUndefined();
    const resolved = resolveCompletionItem(ws, { ...item });
    expect((resolved.documentation as { value: string }).value).toContain('Centered and aspect corrected.');
    const mix = resolveCompletionItem(ws, { ...find(result, 'mix')! });
    expect((mix.documentation as { value: string }).value).toContain('mix(');
  });

  it('offers macros in #define bodies without locals', () => {
    const { result } = complete(MAIN_HEAD + '#define TWO_PI_X (2.0 * P|)\n');
    expect(labels(result)).toContain('PI');
  });
});

describe('auto-include completion', () => {
  const SRC = MAIN_HEAD + 'void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  float n = gno|\n}\n';

  it('offers symbols from files that are not included, with the include path', () => {
    const { result } = complete(SRC);
    const viaLib = find(result, 'gnoise', 'lib/procedural.glsl');
    const direct = find(result, 'gnoise', 'lygia/generative/gnoise.glsl');
    expect(viaLib).toBeDefined();
    expect(direct).toBeDefined();
    // The user's library re-exporting it sorts first.
    expect(viaLib!.sortText! < direct!.sortText!).toBe(true);
    // One item per file: overloads are merged.
    expect(itemsOf(result).filter((i) => i.label === 'gnoise' && i.labelDetails?.description === 'lygia/generative/gnoise.glsl')).toHaveLength(1);
    expect(direct!.detail).toContain('+1 overload');
  });

  it('adds the #include line after the last include when selected', () => {
    const { result, text } = complete(SRC);
    const item = find(result, 'gnoise', 'lygia/generative/gnoise.glsl')!;
    expect(item.additionalTextEdits).toHaveLength(1);
    const out = applyEdits(text, item.additionalTextEdits!);
    expect(out.startsWith('#include "lib/common.glsl"\n#include "lygia/generative/gnoise.glsl"\n\nvoid mainImage')).toBe(true);
  });

  it('ranks not-yet-included symbols after everything visible', () => {
    const { result } = complete(MAIN_HEAD + 'float gnomon = 1.0;\nvoid f() { gno| }\n');
    expect(find(result, 'gnomon')!.sortText! < find(result, 'gnoise', 'lygia/generative/gnoise.glsl')!.sortText!).toBe(true);
  });

  it('does not offer names already reachable through includes', () => {
    const { result } = complete(MAIN_HEAD + 'void f() { P| }\n');
    const pis = itemsOf(result).filter((i) => i.label === 'PI');
    expect(pis).toHaveLength(1);
    expect(pis[0].additionalTextEdits).toBeUndefined();
  });

  it('offers macros and function-like macros', () => {
    const { result } = complete(MAIN_HEAD + 'void f() { satu| }\n');
    const sat = find(result, 'saturate', 'lygia/math/saturate.glsl')!;
    expect(sat.kind).toBe(CompletionItemKind.Function);
    expect(sat.insertText).toBe('saturate($0)');
    expect(labels(result)).not.toContain('FNC_SATURATE');
  });

  it('offers structs', () => {
    const { result } = complete('void f() { CircleI| }\n');
    expect(find(result, 'CircleInfo', 'lygia/sdf/circleSDF.glsl')!.kind).toBe(CompletionItemKind.Struct);
  });

  it('never offers symbols of shader entry points, the file itself or includers (cycles)', () => {
    expect(find(complete('void f() { onlyIn| }\n').result, 'onlyInShader')).toBeUndefined();
    const files = { 'lib/a.glsl': '#include "b.glsl"\nfloat fromA(float x) { return x; }\n' };
    const { result } = complete('float fromB(float x) { return fromA|(x); }\n', { path: 'lib/b.glsl', files });
    expect(find(result, 'fromA')).toBeUndefined();
  });

  it('uses ../ paths from subfolders', () => {
    const { result, text } = complete('// eyes shader\n\nvoid mainImage(out vec4 c, in vec2 f) { c = vec4(satu|); }\n', { path: 'eyes/curl/shader.glsl' });
    const sat = find(result, 'saturate', '../../lygia/math/saturate.glsl')!;
    expect(sat).toBeDefined();
    expect(applyEdits(text, sat.additionalTextEdits!)).toBe('// eyes shader\n\n#include "../../lygia/math/saturate.glsl"\n\nvoid mainImage(out vec4 c, in vec2 f) { c = vec4(satu); }\n');
  });

  it('matches word starts and camel humps, not arbitrary substrings', () => {
    expect(matchScore('gnoise', 'gno')).toBe(0);
    expect(matchScore('circleSDF', 'sdf')).toBeGreaterThan(0);
    expect(matchScore('gnoise', 'noise')).toBe(-1);
    expect(matchScore('rgb2hsv', 'hsv')).toBeGreaterThan(0);
  });

  it('offers not-yet-included functions and structs on an empty prefix (Ctrl+Space), lib/ first', () => {
    const { result } = complete(MAIN_HEAD + 'void f() { | }\n');
    expect(result!.isIncomplete).toBe(true);
    const auto = itemsOf(result).filter((i) => i.additionalTextEdits);
    expect(auto.length).toBeGreaterThan(0);
    expect(auto.every((i) => i.kind === 3 || i.kind === 22 || i.kind === 7)).toBe(true); // function / struct, no macros
    expect(auto.some((i) => i.label === 'circleSDF')).toBe(true);
    const sorted = [...auto].sort((a, b) => a.sortText!.localeCompare(b.sortText!));
    expect(sorted[0].labelDetails?.description).toMatch(/^lib\//);
  });

  it('respects glslLsp.completion.autoInclude = false', () => {
    const { result } = complete(SRC, { autoInclude: false });
    expect(find(result, 'gnoise')).toBeUndefined();
    expect(result!.isIncomplete).toBe(false);
  });

  it('documents the include it will add', () => {
    const { result, ws } = complete(SRC);
    const item = resolveCompletionItem(ws, { ...find(result, 'gnoise', 'lygia/generative/gnoise.glsl')! });
    const md = (item.documentation as { value: string }).value;
    expect(md).toContain('Gradient Noise');
    expect(md).toContain('Adds `#include "lygia/generative/gnoise.glsl"`');
  });
});

describe('member completion', () => {
  const body = (decl: string, expr: string) =>
    `struct Material { vec3 albedo; // base colour\n float rough; };\nMaterial getMat() { Material m; return m; }\nvoid f(vec2 uv) {\n  ${decl}\n  ${expr}\n}\n`;

  it('offers swizzles sized to the vector', () => {
    const { result } = complete(body('', 'uv.|'), { triggerCharacter: '.' });
    const ls = labels(result);
    for (const l of ['x', 'y', 'xy', 'r', 'g', 'rg', 's', 't', 'st']) expect(ls).toContain(l);
    expect(ls).not.toContain('z');
    expect(ls).not.toContain('xyz');
    expect(find(result, 'xy')!.detail).toContain('vec2');
    expect(find(result, 'x')!.detail).toContain('float');
  });

  it('extends a typed swizzle', () => {
    const { result } = complete(body('vec4 c = vec4(1.0);', 'c.xx|'));
    expect(labels(result)).toEqual(expect.arrayContaining(['xx', 'xxy', 'xxw']));
    expect(result!.isIncomplete).toBe(true);
  });

  it('offers struct fields with docs', () => {
    const { result } = complete(body('Material mat;', 'mat.|'), { triggerCharacter: '.' });
    expect(labels(result)).toEqual(['albedo', 'rough']);
    expect(find(result, 'albedo')!.detail).toBe('vec3 albedo');
    expect((find(result, 'albedo')!.documentation as { value: string }).value).toContain('base colour');
  });

  it('follows function return types, member chains, indexing and constructors', () => {
    expect(labels(complete(body('', 'getMat().|')).result)).toContain('rough');
    expect(labels(complete(body('Material mat;', 'mat.albedo.|')).result)).toContain('xyz');
    expect(labels(complete(body('mat3 m;', 'm[0].|')).result)).toContain('xyz');
    expect(labels(complete(body('vec3 arr[4];', 'arr[1].|')).result)).toContain('xyz');
    expect(labels(complete(body('', 'vec3(1.0).|')).result)).toContain('xyz');
    expect(labels(complete(body('vec3 arr[4];', 'arr.|')).result)).toEqual(['length']);
  });

  it('works on half-typed code and unknown receivers', () => {
    expect(labels(complete('void f(vec3 p) {\n  p.|\n').result)).toContain('xyz');
    expect(labels(complete('void f() { unknownThing.| }').result)).toEqual([]);
  });

  it('builds every swizzle set for vec4', () => {
    const items = swizzleItems('ivec4', '');
    expect(items).toHaveLength(45);
    expect(items.find((i) => i.label === 'xyzw')!.detail).toContain('ivec4');
    expect(items.find((i) => i.label === 'a')!.detail).toContain('int');
  });
});

describe('preprocessor completion', () => {
  it('offers directives as snippets after #', () => {
    const { result } = complete('#|', { triggerCharacter: '#' });
    const ls = labels(result);
    for (const d of ['include', 'define', 'ifdef', 'ifndef', 'if', 'else', 'elif', 'endif', 'version', 'extension', 'pragma', 'line', 'iChannel0', 'iChannel3', 'iUniform', 'iKeyboard']) {
      expect(ls).toContain('#' + d);
    }
    const inc = find(result, '#include')!;
    expect(inc.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect((inc.textEdit as { newText: string }).newText).toMatch(/^include "\$(1|\{1\})"$/);
    expect(inc.command?.command).toBe('editor.action.triggerSuggest');
  });

  it('strips placeholders without snippet support', () => {
    const { result } = complete('#|', { snippetSupport: false });
    expect((find(result, '#include')!.textEdit as { newText: string }).newText).toBe('include ""');
  });

  it('offers macro names in #ifdef', () => {
    const { result } = complete(MAIN_HEAD + '#define LOCAL_OPT 1\n#ifdef |\n');
    expect(labels(result)).toEqual(expect.arrayContaining(['LOCAL_OPT', 'PI']));
  });

  it('offers versions', () => {
    expect(labels(complete('#version |').result)).toContain('300 es');
  });
});

describe('#include path completion', () => {
  it('lists folders then files relative to the file', () => {
    const { result } = complete('#include "|"', { triggerCharacter: '"' });
    const ls = labels(result);
    expect(ls).toEqual(expect.arrayContaining(['lib/', 'lygia/', 'other/']));
    expect(ls).not.toContain('main.glsl');
    const lib = find(result, 'lib/')!;
    expect(lib.kind).toBe(CompletionItemKind.Folder);
    expect(lib.command?.command).toBe('editor.action.triggerSuggest');
  });

  it('browses LYGIA folders', () => {
    const { result } = complete('#include "lygia/|"', { triggerCharacter: '/' });
    expect(labels(result)).toEqual(['generative/', 'math/', 'sdf/']);
    const files = complete('#include "lygia/math/sat|"');
    const sat = find(files.result, 'saturate.glsl')!;
    expect(sat.kind).toBe(CompletionItemKind.File);
    expect(sat.textEdit).toMatchObject({ newText: 'saturate.glsl', range: { start: { character: 21 }, end: { character: 24 } } });
  });

  it('appends the closing quote when missing', () => {
    const { result } = complete('#include "lib/|');
    expect((find(result, 'common.glsl')!.textEdit as { newText: string }).newText).toBe('common.glsl"');
  });

  it('offers ../ from subfolders and resolves it', () => {
    const { result } = complete('#include "|"', { path: 'eyes/curl/shader.glsl' });
    expect(labels(result)).toContain('../');
    const up = complete('#include "../../|"', { path: 'eyes/curl/shader.glsl' });
    expect(labels(up.result)).toEqual(expect.arrayContaining(['lib/', 'lygia/']));
  });

  it('falls back to workspace roots for root-relative paths', () => {
    const { result } = complete('#include "lygia/math/|"', { path: 'eyes/shader.glsl' });
    expect(labels(result)).toContain('const.glsl');
  });
});
