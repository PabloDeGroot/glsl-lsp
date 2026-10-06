import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getBuiltins } from '../server/src/builtins';
import { fsPathToUri, MemoryFileSystem, NodeFileSystem, parse, Workspace } from '../server/src/core';
import { IncludeContext, includeTextEdit } from '../server/src/features/autoInclude';
import { computeCompletion } from '../server/src/features/completion';
import { computeCodeActions } from '../server/src/features/codeActions';
import { applyEdits, LIB_FILES } from './completionHelpers';
import { cursor, makeWorkspace, uri } from './helpers';

function insert(text: string, path = 'lygia/generative/gnoise.glsl'): string {
  const model = parse(text, uri('main.glsl'));
  return applyEdits(text, [includeTextEdit(model, path)]);
}

describe('include insertion layouts', () => {
  it('goes after the last #include', () => {
    expect(insert('#include "a.glsl"\n#include "b.glsl"\n\nvoid f() {}\n')).toBe(
      '#include "a.glsl"\n#include "b.glsl"\n#include "lygia/generative/gnoise.glsl"\n\nvoid f() {}\n',
    );
  });

  it('goes after #version, #extension and precision statements', () => {
    expect(insert('#version 300 es\n#extension GL_OES_standard_derivatives : enable\nprecision highp float;\n')).toBe(
      '#version 300 es\n#extension GL_OES_standard_derivatives : enable\nprecision highp float;\n#include "lygia/generative/gnoise.glsl"\n',
    );
  });

  it('goes after a leading header comment, separated by blank lines', () => {
    expect(insert('// My shader.\n// Second line.\n\nvoid f() {}\n')).toBe('// My shader.\n// Second line.\n\n#include "lygia/generative/gnoise.glsl"\n\nvoid f() {}\n');
    // A comment directly above the first declaration documents it: keep them together.
    expect(insert('// Returns one.\nfloat one() { return 1.0; }\n')).toBe('#include "lygia/generative/gnoise.glsl"\n\n// Returns one.\nfloat one() { return 1.0; }\n');
    expect(insert('/* a */ float x;\nfloat y;\n')).toBe('#include "lygia/generative/gnoise.glsl"\n\n/* a */ float x;\nfloat y;\n');
    expect(insert('/*\n header\n*/\n\nvoid f() {}\n')).toBe('/*\n header\n*/\n\n#include "lygia/generative/gnoise.glsl"\n\nvoid f() {}\n');
  });

  it('goes after shader-toy directives', () => {
    expect(insert('#iChannel0 "file://tex.png"\n#iKeyboard\nvoid f() {}\n')).toBe('#iChannel0 "file://tex.png"\n#iKeyboard\n#include "lygia/generative/gnoise.glsl"\n\nvoid f() {}\n');
  });

  it('goes at the top of a file without header', () => {
    expect(insert('void f() {}\n')).toBe('#include "lygia/generative/gnoise.glsl"\n\nvoid f() {}\n');
    expect(insert('')).toBe('#include "lygia/generative/gnoise.glsl"\n');
  });

  it('handles a last include line without trailing newline', () => {
    expect(insert('#include "a.glsl"')).toBe('#include "a.glsl"\n#include "lygia/generative/gnoise.glsl"');
  });

  it('matches angle-bracket style and CRLF line endings', () => {
    expect(insert('#include <a.glsl>\nvoid f() {}\n')).toBe('#include <a.glsl>\n#include <lygia/generative/gnoise.glsl>\nvoid f() {}\n');
    const crlf = parse('// head\r\n\r\nvoid f() {}\r\n', uri('main.glsl'));
    expect(includeTextEdit(crlf, 'x.glsl').newText).toBe('\r\n#include "x.glsl"\r\n');
  });
});

describe('IncludeContext candidates', () => {
  const files = {
    ...LIB_FILES,
    'main.glsl': '#include "lib/common.glsl"\nvoid mainImage(out vec4 c, in vec2 f) {}\n',
    'lib/a.glsl': '#include "b.glsl"\nfloat fromA(float x) { return x; }\n',
    'lib/b.glsl': 'float fromB(float x) { return x; }\n',
    'lygia/math/dup.glsl': 'float dupFn(float x) { return x; }\n',
    'lygia/deeper/nested/dup.glsl': 'float dupFn(float x) { return x; }\n',
  };
  const ctxFor = (path: string) => {
    const { ws } = makeWorkspace(files);
    return new IncludeContext(ws, ws.getModel(uri(path))!);
  };

  it('prefers a re-exporting library, then the shortest declaring path', () => {
    const c = ctxFor('main.glsl');
    expect(c.candidatesFor('gnoise').map((x) => [x.path, x.via])).toEqual([
      ['lib/procedural.glsl', true],
      ['lygia/generative/gnoise.glsl', false],
    ]);
    expect(c.candidatesFor('dupFn').map((x) => x.path)).toEqual(['lygia/math/dup.glsl', 'lygia/deeper/nested/dup.glsl']);
  });

  it('returns nothing for visible, unknown or entry-point-only names', () => {
    const c = ctxFor('main.glsl');
    expect(c.candidatesFor('PI')).toEqual([]);
    expect(c.candidatesFor('uvCentered')).toEqual([]);
    expect(c.candidatesFor('nope')).toEqual([]);
    expect(c.candidatesFor('onlyInShader')).toEqual([]);
  });

  it('never proposes a cycle or a self include', () => {
    expect(ctxFor('lib/b.glsl').candidatesFor('fromA')).toEqual([]);
    expect(ctxFor('lib/a.glsl').candidatesFor('fromA')).toEqual([]);
  });
});

describe('Windows drive letter URIs', () => {
  const ROOT_FS = 'C:\\Pablo\\shader';
  const root = fsPathToUri(ROOT_FS);
  function winWorkspace(mainText: string) {
    const fs = new MemoryFileSystem();
    for (const [p, t] of Object.entries(LIB_FILES)) fs.set(`${root}/${p}`, t);
    fs.set(`${root}/eyes/curl/shader.glsl`, mainText);
    // A different spelling of the same root, as clients may send it.
    const ws = new Workspace({ fs, builtins: getBuiltins(), roots: ['file:///C:/Pablo/shader'] });
    ws.indexWorkspaceSync();
    return ws;
  }

  it('completes with ../ relative includes regardless of URI spelling', () => {
    const { text, position } = cursor('void mainImage(out vec4 c, in vec2 f) { c = vec4(gno|); }\n');
    const ws = winWorkspace(text);
    const result = computeCompletion(
      { workspace: ws, snippetSupport: true, autoInclude: true },
      { textDocument: { uri: 'file:///C:/Pablo/shader/eyes/curl/shader.glsl' }, position },
    );
    const item = result!.items.find((i) => i.label === 'gnoise' && i.labelDetails?.description === '../../lygia/generative/gnoise.glsl');
    expect(item).toBeDefined();
    expect(item!.additionalTextEdits![0].newText).toBe('#include "../../lygia/generative/gnoise.glsl"\n\n');
  });

  it('offers the include quick fix with the client URI as the edit key', () => {
    const text = 'void mainImage(out vec4 c, in vec2 f) { c = vec4(gnoise(f)); }\n';
    const ws = winWorkspace(text);
    const clientUri = 'file:///c%3A/Pablo/shader/eyes/curl/shader.glsl';
    const actions = computeCodeActions(
      { workspace: ws },
      { textDocument: { uri: clientUri }, range: { start: { line: 0, character: 52 }, end: { line: 0, character: 52 } }, context: { diagnostics: [] } },
    );
    expect(actions.map((a) => a.title)).toContain('Add #include "../../lygia/generative/gnoise.glsl"');
    expect(Object.keys(actions[0].edit!.changes!)).toEqual([clientUri]);
  });
});

const PARENT = resolve(__dirname, '..', '..');
describe.skipIf(!existsSync(resolve(PARENT, 'lygia')) || !existsSync(resolve(PARENT, 'lib')))('auto-include on the real shader workspace', () => {
  it('completes LYGIA symbols fast', async () => {
    const ws = new Workspace({ fs: new NodeFileSystem(), builtins: getBuiltins(), roots: [fsPathToUri(PARENT)], exclude: ['node_modules', '.git', 'out', 'dist', 'glsl-lsp', 'extension'] });
    ws.indexWorkspaceSync();
    const { text, position } = cursor('#include "lib/color.glsl"\n#include "lib/procedural.glsl"\n\nvoid mainImage(out vec4 c, in vec2 f) {\n  float n = sno|\n}\n');
    const docUri = fsPathToUri(resolve(PARENT, 'zz_completion_probe.glsl'));
    ws.openDocument(docUri, text, 1);
    const env = { workspace: ws, snippetSupport: true, autoInclude: true };
    const params = { textDocument: { uri: docUri }, position };
    computeCompletion(env, params); // warm caches
    const t0 = performance.now();
    const res = computeCompletion(env, params);
    const ms = performance.now() - t0;
    expect(res!.items.length).toBeGreaterThan(50);
    // snoise is visible through lib/procedural.glsl: no include item for it.
    expect(res!.items.filter((i) => i.label === 'snoise').every((i) => !i.additionalTextEdits)).toBe(true);
    // A LYGIA function that lib/ does not pull in gets an include item.
    const t1 = performance.now();
    const res2 = computeCompletion(env, { textDocument: { uri: docUri }, position: { line: position.line, character: position.character } });
    void res2;
    expect(ms).toBeLessThan(150);
    expect(performance.now() - t1).toBeLessThan(150);
    const { text: t2, position: p2 } = cursor('void mainImage(out vec4 c, in vec2 f) {\n  float d = circleS|\n}\n');
    ws.updateDocument(docUri, t2, 2);
    const t3 = performance.now();
    const res3 = computeCompletion(env, { textDocument: { uri: docUri }, position: p2 });
    const ms3 = performance.now() - t3;
    const circle = res3!.items.find((i) => i.label === 'circleSDF' && i.additionalTextEdits);
    expect(circle?.labelDetails?.description).toMatch(/circleSDF\.glsl$/);
    // Ctrl+Space with an empty prefix also offers not-yet-included functions.
    const { text: t4, position: p4 } = cursor('void mainImage(out vec4 c, in vec2 f) {\n  |\n}\n');
    ws.updateDocument(docUri, t4, 3);
    computeCompletion(env, { textDocument: { uri: docUri }, position: p4 });
    const t5 = performance.now();
    const res4 = computeCompletion(env, { textDocument: { uri: docUri }, position: p4 });
    const ms4 = performance.now() - t5;
    const auto = res4!.items.filter((i) => i.additionalTextEdits);
    expect(auto.length).toBeGreaterThan(50);
    expect(auto.length).toBeLessThanOrEqual(300);
    expect(res4!.isIncomplete).toBe(true);
    console.log(`completion timings: warm ${ms.toFixed(1)} ms, after edit ${ms3.toFixed(1)} ms, empty prefix ${ms4.toFixed(1)} ms, items ${res3!.items.length}/${res4!.items.length}`);
    expect(ms3).toBeLessThan(150);
    expect(ms4).toBeLessThan(150);
  });
});
