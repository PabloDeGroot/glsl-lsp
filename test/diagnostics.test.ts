import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { getBuiltins } from '../server/src/builtins';
import { fsPathToUri, NodeFileSystem, Workspace } from '../server/src/core';
import {
  computeFastDiagnostics,
  computeGlslangDiagnostics,
  DiagnosticStore,
  flatten,
  mapGlslangMessages,
  parseGlslangOutput,
  planValidation,
  runGlslang,
} from '../server/src/features/diagnostics';
import { makeWorkspace, uri } from './helpers';

const fast = (files: Record<string, string>, file = 'main.glsl', opts = {}) => {
  const { ws } = makeWorkspace(files);
  return { ws, diags: computeFastDiagnostics(ws, uri(file), opts) };
};
const codes = (d: { code?: unknown }[]) => d.map((x) => x.code);
const messages = (diags: { message: string; code?: unknown }[], code: string) => diags.filter((d) => d.code === code).map((d) => d.message);

describe('includes', () => {
  it('reports an unresolved include on the path range', () => {
    const { diags } = fast({ 'main.glsl': '#include "nope.glsl"\nvoid main() {}' });
    const d = diags.find((x) => x.code === 'unresolved-include')!;
    expect(d.severity).toBe(DiagnosticSeverity.Error);
    expect(d.range).toEqual({ start: { line: 0, character: 10 }, end: { line: 0, character: 19 } });
  });

  it('warns about include cycles', () => {
    const { diags } = fast({ 'main.glsl': '#include "a.glsl"\n', 'a.glsl': '#include "main.glsl"\nfloat a;' });
    expect(codes(diags)).toContain('include-cycle');
    expect(diags.find((d) => d.code === 'include-cycle')!.severity).toBe(DiagnosticSeverity.Warning);
  });

  it('does not flag resolvable includes', () => {
    const { diags } = fast({ 'main.glsl': '#include "a.glsl"\nvoid f() { a(); }', 'a.glsl': 'void a() {}' });
    expect(diags).toEqual([]);
  });
});

describe('duplicate definitions', () => {
  it('flags two unguarded definitions with the same signature, across files too', () => {
    const { diags } = fast({
      'main.glsl': '#include "a.glsl"\nfloat f(float x) { return x; }\nfloat g(float x) { return x; }\nfloat g(float y) { return y; }',
      'a.glsl': 'float f(float q) { return q; }',
    });
    const msgs = messages(diags, 'duplicate-definition');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain("'f(float)'");
    expect(msgs[0]).toContain('a.glsl:1');
    expect(msgs[1]).toContain("'g(float)'");
  });

  it('allows overloads and prototypes', () => {
    const { diags } = fast({ 'main.glsl': 'float f(float x);\nfloat f(float x) { return x; }\nfloat f(vec2 x) { return x.x; }' });
    expect(messages(diags, 'duplicate-definition')).toEqual([]);
  });

  it('ignores definitions inside conditionals / include guards', () => {
    const { diags } = fast({
      'main.glsl': '#include "a.glsl"\n#ifdef FAST\nfloat f(float x) { return x; }\n#else\nfloat f(float x) { return 2.0 * x; }\n#endif\n',
      'a.glsl': '#ifndef FNC_F\n#define FNC_F\nfloat f(float x) { return x; }\n#endif\n',
    });
    expect(messages(diags, 'duplicate-definition')).toEqual([]);
  });
});

describe('undeclared identifiers', () => {
  const body = (s: string) => `void mainImage(out vec4 c, in vec2 p) {\n${s}\n}`;

  it('warns for names defined nowhere', () => {
    const { diags } = fast({ 'main.glsl': body('c = vec4(missing, 0.0, 0.0, 1.0);') });
    const d = diags.find((x) => x.code === 'undeclared-identifier')!;
    expect(d.severity).toBe(DiagnosticSeverity.Warning);
    expect(d.data).toEqual({ name: 'missing' });
  });

  it('is an error (with a hint) when a workspace file defines it', () => {
    const { diags } = fast({ 'main.glsl': body('c = vec4(helper(p), 1.0);'), 'lib/h.glsl': 'vec3 helper(vec2 p) { return vec3(p, 0.0); }' });
    const d = diags.find((x) => x.code === 'undeclared-identifier')!;
    expect(d.severity).toBe(DiagnosticSeverity.Error);
    expect(d.message).toContain('lib/h.glsl');
    expect(d.data).toEqual({ name: 'helper' });
  });

  it('is silent when the definition is included', () => {
    const { diags } = fast({ 'main.glsl': '#include "lib/h.glsl"\n' + body('c = vec4(helper(p), 1.0);'), 'lib/h.glsl': 'vec3 helper(vec2 p) { return vec3(p, 0.0); }' });
    expect(diags).toEqual([]);
  });

  it('ignores builtins, uniforms, swizzles, fields, locals, params and loop variables', () => {
    const src = [
      'struct S { vec2 pos; float r; };',
      'uniform sampler2D tex;',
      'const float K = 2.0;',
      'float h(S s, float k) {',
      '  for (int i = 0; i < 3; i++) { k += float(i); }',
      '  return s.pos.x * s.r + k;',
      '}',
      body('  S s = S(p, 1.0); vec4 q = texture(iChannel0, p / iResolution.xy); c = vec4(q.rgb * max(h(s, K), iTime), q.a) + iMouse.xxxx; c.rg = c.bg;'),
    ].join('\n');
    const { diags } = fast({ 'main.glsl': src });
    expect(diags).toEqual([]);
  });

  it('skips #if regions, macro bodies and macro-declared names', () => {
    const src = [
      '#define DECL(T, N) T N = T(1.0);',
      '#define ALIAS missing_in_macro_body',
      '#if QUALITY > 1',
      'float a = unknownInIf;',
      '#endif',
      'DECL(float, generated)',
      body('c = vec4(generated);'),
    ].join('\n');
    const { diags } = fast({ 'main.glsl': src });
    expect(messages(diags, 'undeclared-identifier')).toEqual([]);
  });

  it('gives up when macros use token pasting', () => {
    const { diags } = fast({ 'main.glsl': '#define CAT(a, b) a##b\n' + body('c = vec4(whatever);') });
    expect(messages(diags, 'undeclared-identifier')).toEqual([]);
  });

  it('checks inside include guards', () => {
    const { diags } = fast({ 'main.glsl': '#ifndef X_H\n#define X_H\nfloat f() { return nope; }\n#endif\n' });
    expect(messages(diags, 'undeclared-identifier')).toHaveLength(1);
  });

  it('can be disabled', () => {
    const { diags } = fast({ 'main.glsl': body('c = vec4(missing);') }, 'main.glsl', { undeclared: false });
    expect(diags).toEqual([]);
  });

  it('survives half-typed code', () => {
    const { diags } = fast({ 'main.glsl': 'float f(float x) {\n  return mix(x, \n' });
    expect(Array.isArray(diags)).toBe(true);
  });
});

describe('flatten', () => {
  const lines = (s: string) => s.split('\n');

  it('wraps a Shadertoy file and maps lines back', () => {
    const { ws } = makeWorkspace({
      'main.glsl':
        '#include "a.glsl"\n#iUniform float u_x = 1.0 in { 0.0, 2.0 }\n#iUniform color3 u_c = color3(1.0, 0.0, 0.0)\n#iChannel0 "file://x.png"\n#iChannel0::Type "CubeMap"\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(a()); }',
      'a.glsl': '// helper\nfloat a() { return 1.0; }',
    });
    const f = flatten(ws, uri('main.glsl'), { shadertoy: true });
    const src = lines(f.source);
    expect(src[0]).toBe('#version 300 es');
    expect(f.source).toContain('uniform float u_x;');
    expect(f.source).toContain('uniform vec3 u_c;');
    expect(f.source).toContain('uniform samplerCube iChannel0;');
    expect(f.source).toContain('uniform sampler2D iChannel1;');
    expect(f.source).not.toContain('#iChannel');
    expect(f.source).toContain('mainImage(_fragColor, gl_FragCoord.xy)');
    const idx = src.findIndex((l) => l.startsWith('float a()'));
    expect(f.lineMap[idx]).toMatchObject({ uri: uri('a.glsl'), line: 1, via: { line: 0, path: 'a.glsl' } });
    const idx2 = src.findIndex((l) => l.startsWith('void mainImage'));
    expect(f.lineMap[idx2]).toMatchObject({ uri: uri('main.glsl'), line: 5 });
    expect(f.lineMap[idx2]?.via).toBeUndefined();
    expect(f.lineMap[0]).toBeUndefined();
    expect(f.lineMap.length).toBe(src.length - 1); // trailing newline
  });

  it('inlines every file once and handles cycles', () => {
    const { ws } = makeWorkspace({
      'main.glsl': '#include "a.glsl"\n#include "b.glsl"\nvoid mainImage(out vec4 c, in vec2 p) {}',
      'a.glsl': '#include "b.glsl"\nfloat a;',
      'b.glsl': '#include "a.glsl"\nfloat b;',
    });
    const f = flatten(ws, uri('main.glsl'), { shadertoy: true });
    expect(f.source.match(/float a;/g)).toHaveLength(1);
    expect(f.source.match(/float b;/g)).toHaveLength(1);
    expect(f.files).toHaveLength(3);
  });

  it('adds keyboard helpers for #iKeyboard (also from included files)', () => {
    const { ws } = makeWorkspace({
      'main.glsl': '#include "k.glsl"\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(isKeyDown(Key_A) ? 1.0 : 0.0); }',
      'k.glsl': '#iKeyboard\n',
    });
    const f = flatten(ws, uri('main.glsl'), { shadertoy: true });
    expect(f.source).toContain('bool isKeyDown(int k)');
    expect(f.source).toContain('const int Key_A = 65;');
    expect(f.source).not.toContain('#iKeyboard');
  });

  it('passes versioned non-Shadertoy files through with includes inlined', () => {
    const { ws } = makeWorkspace({ 'x.frag': '#version 330 core\n#include "a.glsl"\nout vec4 o;\nvoid main() { o = vec4(a()); }', 'a.glsl': 'float a() { return 1.0; }' });
    const f = flatten(ws, uri('x.frag'), { shadertoy: false });
    expect(lines(f.source)[0]).toBe('#version 330 core');
    expect(f.stage).toBe('frag');
    expect(f.source).toContain('float a()');
    expect(f.source).not.toContain('Shadertoy');
  });

  it('plans validation per file kind', () => {
    const { ws } = makeWorkspace({
      'toy.glsl': 'void mainImage(out vec4 c, in vec2 p) {}',
      'lib.glsl': 'float a() { return 1.0; }',
      'v.vert': '#version 330\nvoid main() {}',
      'bare.glsl': 'void main() {}',
    });
    expect(planValidation(ws.getModel(uri('toy.glsl'))!, true)).toEqual({ stage: 'frag', shadertoy: true });
    expect(planValidation(ws.getModel(uri('lib.glsl'))!, true)).toBeUndefined();
    expect(planValidation(ws.getModel(uri('v.vert'))!, true)).toEqual({ stage: 'vert', shadertoy: false });
    expect(planValidation(ws.getModel(uri('bare.glsl'))!, true)).toBeUndefined();
  });
});

describe('glslang output', () => {
  it('parses errors and warnings and drops noise', () => {
    const out = [
      'stdin',
      "ERROR: 0:12: 'foo' : undeclared identifier ",
      "ERROR: 0:12: '' : compilation terminated ",
      "WARNING: 0:3: 'x' : unused",
      'ERROR: 2 compilation errors.  No code generated.',
      '',
    ].join('\n');
    expect(parseGlslangOutput(out)).toEqual([
      { severity: 'error', line: 12, text: "'foo' : undeclared identifier" },
      { severity: 'warning', line: 3, text: "'x' : unused" },
    ]);
  });

  it('maps messages to the right file and adds a summary on the #include line', () => {
    const { ws } = makeWorkspace({
      'main.glsl': '#include "a.glsl"\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(a() + vec3(p, 0.0)); }',
      'a.glsl': '// helper\nvec3 a() { vec2 v = vec3(1.0); return v; }',
    });
    const f = flatten(ws, uri('main.glsl'), { shadertoy: true });
    const aLine = f.lineMap.findIndex((o) => o?.uri === uri('a.glsl') && o.line === 1) + 1;
    const mainLine = f.lineMap.findIndex((o) => o?.uri === uri('main.glsl') && o.line === 1) + 1;
    const { byUri } = mapGlslangMessages(
      parseGlslangOutput(`ERROR: 0:${aLine}: 'v' : cannot convert\nERROR: 0:${mainLine}: '+' : wrong operand types\nERROR: 0:1: 'x' : in preamble`),
      { rootUri: uri('main.glsl'), flattened: f, lineText: (u, l) => ws.getModel(u)!.text.split('\n')[l], displayPath: (u) => ws.displayPath(u) },
    );
    const inA = byUri.get(uri('a.glsl'))!;
    expect(inA).toHaveLength(1);
    expect(inA[0].range.start).toEqual({ line: 1, character: 16 }); // 'v' in `vec3 a() { vec2 v`
    const inMain = byUri.get(uri('main.glsl'))!;
    const summary = inMain.find((d) => d.code === 'glslang-included')!;
    expect(summary.range.start.line).toBe(0);
    expect(summary.message).toContain('a.glsl:2');
    const direct = inMain.find((d) => d.message.startsWith('wrong operand'))!;
    expect(direct.range.start.line).toBe(1);
    expect(inMain.some((d) => d.message.includes('generated Shadertoy wrapper'))).toBe(true);
  });

  it('computeGlslangDiagnostics reports tool failures and skips library files', async () => {
    const { ws } = makeWorkspace({ 'toy.glsl': 'void mainImage(out vec4 c, in vec2 p) {}', 'lib.glsl': 'float a() { return 1.0; }' });
    const missing = await computeGlslangDiagnostics(ws, uri('toy.glsl'), { shadertoy: true, run: async () => ({ ok: false, reason: 'missing' }) });
    expect(missing).toEqual({ kind: 'failed', reason: 'missing', detail: undefined });
    const skipped = await computeGlslangDiagnostics(ws, uri('lib.glsl'), { shadertoy: true, run: async () => ({ ok: true, output: '', exitCode: 0 }) });
    expect(skipped.kind).toBe('skipped');
    const clean = await computeGlslangDiagnostics(ws, uri('toy.glsl'), { shadertoy: true, run: async () => ({ ok: true, output: 'stdin\n', exitCode: 0 }) });
    expect(clean.kind).toBe('done');
  });

  it('runGlslang reports a missing executable', async () => {
    const r = await runGlslang('void main(){}', { exe: 'definitely-not-a-real-glslang-binary', stage: 'frag' });
    expect(r).toMatchObject({ ok: false, reason: 'missing' });
  });
});

describe('DiagnosticStore', () => {
  const d = (line: number, message: string, extra = {}) => ({ range: { start: { line, character: 0 }, end: { line, character: 1 } }, message, ...extra });

  it('merges layers and removes glslang duplicates of fast diagnostics', () => {
    const s = new DiagnosticStore();
    s.setFast('u', [d(3, "Undeclared identifier 'foo'.", { code: 'undeclared-identifier', data: { name: 'foo' } }), d(5, 'expected ;', { code: 'syntax' })]);
    s.setGlslang(
      'u',
      new Map([['u', [d(3, "undeclared identifier ('foo')", { code: 'glslang', severity: 1 }), d(5, "syntax error ('x')", { code: 'glslang', severity: 1 }), d(7, 'other', { code: 'glslang', severity: 2 })]]]),
    );
    expect(s.merged('u').map((x) => x.message)).toEqual(["Undeclared identifier 'foo'.", "syntax error ('x')", 'other']);
  });

  it('tracks which uris a root touched', () => {
    const s = new DiagnosticStore();
    s.setGlslang('root', new Map([['inc', [d(1, 'a')]], ['root', []]]));
    expect(s.merged('inc')).toHaveLength(1);
    const touched = s.setGlslang('root', new Map([['root', []]]));
    expect(touched).toContain('inc');
    expect(s.merged('inc')).toHaveLength(0);
    s.setGlslang('root', new Map([['inc', [d(1, 'a')]]]));
    expect(s.clearDocument('root')).toContain('inc');
    expect(s.merged('inc')).toHaveLength(0);
  });
});

const GLSLANG = spawnSync('glslangValidator', ['--version']).status === 0;
const real = (s: string, st: string) => runGlslang(s, { exe: 'glslangValidator', stage: st });

describe.skipIf(!GLSLANG)('glslangValidator integration', () => {
  it('maps an error in an included file to that file and the #include line', async () => {
    const root = resolve(__dirname, 'fixtures', 'diagnostics');
    const ws = new Workspace({ fs: new NodeFileSystem(), builtins: getBuiltins(), roots: [fsPathToUri(root)] });
    ws.indexWorkspaceSync();
    const mainUri = fsPathToUri(resolve(root, 'main.glsl'));
    const res = await computeGlslangDiagnostics(ws, mainUri, { shadertoy: true, run: real });
    expect(res.kind).toBe('done');
    if (res.kind !== 'done') return;
    const inBroken = res.byUri.get(fsPathToUri(resolve(root, 'lib', 'broken.glsl')))!;
    expect(inBroken.length).toBeGreaterThan(0);
    expect(inBroken[0].range.start.line).toBe(4); // `vec2 bad = c;`
    expect(inBroken[0].severity).toBe(DiagnosticSeverity.Error);
    const summary = res.byUri.get(mainUri)!.find((d) => d.code === 'glslang-included')!;
    expect(summary.range.start.line).toBe(0);
    expect(summary.message).toContain('broken.glsl:5');
  });

  it('accepts a valid Shadertoy shader', async () => {
    const { ws } = makeWorkspace({
      'ok.glsl': '#iUniform float u_k = 1.0 in { 0.0, 2.0 }\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(p / iResolution.xy, sin(iTime) * u_k, 1.0); }',
    });
    const res = await computeGlslangDiagnostics(ws, uri('ok.glsl'), { shadertoy: true, run: real });
    expect(res.kind).toBe('done');
    if (res.kind === 'done') expect([...res.byUri.values()].flat()).toEqual([]);
  });
});
