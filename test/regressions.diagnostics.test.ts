// Regression tests for diagnostics / workspace sync defects found in review.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from 'vscode-languageserver/node';
import { getBuiltins } from '../server/src/builtins';
import { MemoryFileSystem, Workspace, type ModelChangeEvent } from '../server/src/core';
import { computeFastDiagnostics, computeGlslangDiagnostics, DiagnosticStore, flatten, parseGlslangOutput, runGlslang } from '../server/src/features/diagnostics';
import { stageForUri } from '../server/src/features/diagnostics/flatten';
import { makeWorkspace, uri } from './helpers';

const GLSLANG = spawnSync('glslangValidator', ['--version']).status === 0;
const realRun = (s: string, st: string) => runGlslang(s, { exe: 'glslangValidator', stage: st });

describe('workspace events for include targets', () => {
  it('creating a missing include target re-validates its includers', () => {
    const { ws, fs } = makeWorkspace({ 'a.glsl': '#include "b.glsl"\nvoid main(){ float x = helperB(1.0); }\n' });
    ws.openDocument(uri('a.glsl'), '#include "b.glsl"\nvoid main(){ float x = helperB(1.0); }\n', 1);
    expect(computeFastDiagnostics(ws, uri('a.glsl')).map((d) => d.code)).toContain('unresolved-include');
    const events: ModelChangeEvent[] = [];
    ws.onDidChangeModel((e) => events.push(e));
    fs.set(uri('b.glsl'), 'float helperB(float x) { return x; }\n');
    ws.fileCreated(uri('b.glsl'));
    expect(events.flatMap((e) => e.affected)).toContain(uri('a.glsl'));
    expect(events.every((e) => e.fromDisk)).toBe(true);
    expect(computeFastDiagnostics(ws, uri('a.glsl'))).toEqual([]);
  });

  it('deleting a folder removes its files and unresolves includes', () => {
    const { ws, fs } = makeWorkspace({ 'lib/x.glsl': 'float helperX(float x) { return x; }\n', 'a.glsl': '#include "lib/x.glsl"\nvoid main(){ float y = helperX(1.0); }\n' });
    fs.delete(uri('lib/x.glsl'));
    ws.fileDeleted(uri('lib'));
    expect(ws.peekModel(uri('lib/x.glsl'))).toBeUndefined();
    expect(ws.findDeclaringFiles('helperX')).toEqual([]);
    expect(computeFastDiagnostics(ws, uri('a.glsl')).map((d) => d.code)).toContain('unresolved-include');
  });

  it('re-indexing drops excluded files and files of removed roots', () => {
    const fs = new MemoryFileSystem({ 'file:///r1/vendor/v.glsl': 'float vendorFn(){return 1.0;}\n', 'file:///r1/a.glsl': 'void main(){}\n', 'file:///r2/other.glsl': 'float otherRootFn(){return 1.0;}\n' });
    const ws = new Workspace({ fs, builtins: getBuiltins(), roots: ['file:///r1', 'file:///r2'] });
    ws.indexWorkspaceSync();
    expect(ws.lookupGlobal('vendorFn')).toHaveLength(1);
    ws.configure({ exclude: ['vendor'] });
    ws.indexWorkspaceSync();
    expect(ws.lookupGlobal('vendorFn')).toHaveLength(0);
    ws.configure({ roots: ['file:///r1'] });
    ws.indexWorkspaceSync();
    expect(ws.lookupGlobal('otherRootFn')).toHaveLength(0);
  });

  it('re-indexing reloads included files outside the roots', () => {
    const fs = new MemoryFileSystem({ 'file:///ext/e.glsl': 'float extFn(){return 1.0;}\n', 'file:///ws/a.glsl': '#include "e.glsl"\nvoid main(){ float x = extFn2(); }\n' });
    const ws = new Workspace({ fs, builtins: getBuiltins(), roots: ['file:///ws'], includePaths: ['file:///ext'] });
    ws.indexWorkspaceSync();
    expect(ws.findDeclaringFiles('extFn')).toEqual(['file:///ext/e.glsl']);
    fs.set('file:///ext/e.glsl', 'float extFn2(){return 1.0;}\n');
    ws.indexWorkspaceSync();
    expect(ws.findDeclaringFiles('extFn2')).toEqual(['file:///ext/e.glsl']);
    expect(ws.findDeclaringFiles('extFn')).toEqual([]);
  });

  it('watched events in excluded folders do not index files', () => {
    const { ws, fs } = makeWorkspace({ 'main.glsl': 'void main(){}\n', 'node_modules/pkg/old.glsl': 'float nmOld(){return 1.0;}\n' });
    fs.set(uri('node_modules/pkg/new.glsl'), 'float nmNew(){return 1.0;}\n');
    ws.fileCreated(uri('node_modules/pkg/new.glsl'));
    ws.fileChanged(uri('node_modules/pkg/old.glsl'));
    expect(ws.lookupGlobal('nmNew')).toEqual([]);
    expect(ws.lookupGlobal('nmOld')).toEqual([]);
  });

  it('skips folders containing a .glsl-lsp-ignore marker', () => {
    const { ws } = makeWorkspace({ 'main.glsl': 'void main(){}\n', 'ext/test/fixtures/.glsl-lsp-ignore': '', 'ext/test/fixtures/p/f.glsl': 'float fixtureFn(){return 1.0;}\n' });
    expect(ws.lookupGlobal('fixtureFn')).toEqual([]);
  });

  it('flags a change of declared names', () => {
    const { ws } = makeWorkspace({ 'lib.glsl': 'float helper() { return 1.0; }\n' });
    const events: ModelChangeEvent[] = [];
    ws.onDidChangeModel((e) => events.push(e));
    ws.openDocument(uri('lib.glsl'), 'float helper() { return 1.0; }\n', 1);
    ws.updateDocument(uri('lib.glsl'), 'float helper() { return 2.0; }\n', 2);
    ws.updateDocument(uri('lib.glsl'), 'float renamed() { return 2.0; }\n', 3);
    expect(events.map((e) => !!e.namesChanged)).toEqual([false, false, true]);
  });
});

describe('BOM', () => {
  it('a UTF-8 BOM in a file read from disk is stripped', () => {
    const { ws } = makeWorkspace({
      'main.glsl': '#include "a.glsl"\nvoid mainImage(out vec4 c, in vec2 fc) {\n  c = vec4(fa() + fb());\n}\n',
      'a.glsl': '﻿#include "b.glsl"\nfloat fa() { return fb(); }\n',
      'b.glsl': 'float fb() { return 1.0; }',
    });
    expect(computeFastDiagnostics(ws, uri('main.glsl'))).toEqual([]);
    expect(flatten(ws, uri('main.glsl'), { shadertoy: true }).source).not.toContain('﻿');
  });
});

describe('flatten', () => {
  it('maps stages from compound extensions', () => {
    expect(stageForUri('file:///a/shader.vert.glsl')).toBe('vert');
    expect(stageForUri('file:///a/s.vs.glsl')).toBe('vert');
    expect(stageForUri('file:///a/s.comp')).toBe('comp');
    expect(stageForUri('file:///a/s.glsl')).toBe('frag');
    expect(stageForUri('file:///a/my.shader.glsl')).toBe('frag');
  });

  it('blanks #line directives', () => {
    const { ws } = makeWorkspace({ 'main.glsl': '#line 100\nvoid mainImage(out vec4 c, in vec2 fc) {\n  c = vec4(1.0);\n}\n' });
    expect(flatten(ws, uri('main.glsl'), { shadertoy: true }).source).not.toMatch(/#line/);
  });

  it.skipIf(!GLSLANG)('a file included in a false #if branch is still inlined at its real include site', async () => {
    const { ws } = makeWorkspace({
      'main.glsl': '#ifdef FAST\n#include "a.glsl"\n#else\n#include "b.glsl"\n#endif\nvoid mainImage(out vec4 c, in vec2 fc) {\n  c = vec4(f() + g());\n}\n',
      'a.glsl': 'float f() { return 1.0; }',
      'b.glsl': '#include "a.glsl"\nfloat g() { return 2.0; }',
    });
    const out = await computeGlslangDiagnostics(ws, uri('main.glsl'), { shadertoy: true, run: realRun });
    expect(out.kind).toBe('done');
    if (out.kind === 'done') expect([...out.byUri.values()].flat()).toEqual([]);
  });

  it.skipIf(!GLSLANG)('#line in user code does not shift reported lines', async () => {
    const { ws } = makeWorkspace({ 'main.glsl': '#line 100\nvoid mainImage(out vec4 c, in vec2 fc) {\n  c = vec4(oops);\n}\n' });
    const out = await computeGlslangDiagnostics(ws, uri('main.glsl'), { shadertoy: true, run: realRun });
    expect(out.kind).toBe('done');
    if (out.kind === 'done') expect(out.byUri.get(uri('main.glsl'))!.map((d) => d.range.start.line)).toEqual([2]);
  });

  it.skipIf(!GLSLANG)('a *.vert.glsl file validates as a vertex shader', async () => {
    const { ws } = makeWorkspace({ 'shader.vert.glsl': '#version 330\nlayout(location=0) in vec3 p;\nvoid main(){ gl_Position = vec4(p, 1.0); }\n' });
    const out = await computeGlslangDiagnostics(ws, uri('shader.vert.glsl'), { shadertoy: true, run: realRun });
    expect(out.kind).toBe('done');
    if (out.kind === 'done') expect([...out.byUri.values()].flat()).toEqual([]);
  });
});

describe('glslang runs', () => {
  it('a non-zero exit without messages is a failure, not a clean compile', async () => {
    const { ws } = makeWorkspace({ 'main.glsl': 'void mainImage(out vec4 c, in vec2 fc) {\n  c = vec4(1.0) + 1;\n}\n' });
    const out = await computeGlslangDiagnostics(ws, uri('main.glsl'), { shadertoy: true, run: async () => ({ ok: true, output: 'bad option: --stdin\n', exitCode: 9 }) });
    expect(out.kind).toBe('failed');
    // A real compile error exits non-zero too, with messages: still 'done'.
    const out2 = await computeGlslangDiagnostics(ws, uri('main.glsl'), { shadertoy: true, run: async () => ({ ok: true, output: "ERROR: 0:30: 'x' : undeclared identifier\n", exitCode: 2 }) });
    expect(out2.kind).toBe('done');
  });

  it.skipIf(process.platform !== 'win32')('runs a .cmd wrapper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'glsllsp-cmd-'));
    try {
      const cmd = join(dir, 'w.cmd');
      writeFileSync(cmd, '@echo off\r\necho hello %*\r\n');
      const r = await runGlslang('void main(){}', { exe: cmd, stage: 'frag' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.output).toContain('hello --stdin -S frag');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an executable that cannot be started is reported like a missing one', async () => {
    const r = await runGlslang('void main(){}', { exe: join(tmpdir(), 'definitely-not-here-glslang.exe'), stage: 'frag' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing');
  });
});

describe('store', () => {
  it("drops glslang's 'no matching overloaded function' when the fast layer reports the undeclared call", () => {
    const store = new DiagnosticStore();
    const range = { start: { line: 1, character: 11 }, end: { line: 1, character: 13 } };
    const fastD: Diagnostic = { range, severity: 1, code: 'undeclared-identifier', message: "Undeclared identifier 'fa'.", data: { name: 'fa' } };
    store.setFast(uri('m.glsl'), [fastD]);
    store.setGlslang(uri('m.glsl'), new Map([[uri('m.glsl'), [{ range, severity: 1, code: 'glslang', message: "no matching overloaded function found ('fa')" }]]]));
    expect(store.merged(uri('m.glsl')).map((d) => d.code)).toEqual(['undeclared-identifier']);
    expect(store.hasUndeclared(uri('m.glsl'))).toBe(true);
  });
});

describe('synthetic include guards', () => {
  it.skipIf(!GLSLANG)("an error in a guard-less included file does not add a 'missing #endif'", async () => {
    const { ws } = makeWorkspace({
      'b.glsl': '#include "lib.glsl"\nvoid mainImage(out vec4 c, in vec2 fc) {\n  c = vec4(fb());\n}\n',
      'lib.glsl': '// lib\n\nfloat fb() { return undefinedB; }\n',
    });
    const out = await computeGlslangDiagnostics(ws, uri('b.glsl'), { shadertoy: true, run: realRun });
    expect(out.kind).toBe('done');
    if (out.kind !== 'done') return;
    const all = [...out.byUri.values()].flat().map((d) => d.message);
    expect(all.some((m) => /undeclared identifier/.test(m))).toBe(true);
    expect(all.filter((m) => /#endif/.test(m))).toEqual([]);
  });

  it("drops 'missing #endif' reported because compilation terminated early", () => {
    const out = "ERROR: 0:31: 'undefinedB' : undeclared identifier \nERROR: 0:31: '' : missing #endif \nERROR: 0:31: '' : compilation terminated \nERROR: 3 compilation errors.  No code generated.\n";
    expect(parseGlslangOutput(out).map((m) => m.text)).toEqual(["'undefinedB' : undeclared identifier"]);
  });

  it.skipIf(!GLSLANG)('a real unclosed #if in an included file is reported in that file, not on generated lines', async () => {
    const { ws } = makeWorkspace({
      'b.glsl': '#include "lib.glsl"\nvoid mainImage(out vec4 c, in vec2 fc) {\n  c = vec4(1.0);\n}\n',
      'lib.glsl': '#ifdef FOO\nfloat fb() { return 1.0; }\n',
    });
    const out = await computeGlslangDiagnostics(ws, uri('b.glsl'), { shadertoy: true, run: realRun });
    expect(out.kind).toBe('done');
    if (out.kind !== 'done') return;
    const lib = out.byUri.get(uri('lib.glsl')) ?? [];
    expect(lib.map((d) => [d.range.start.line, d.message])).toEqual([[0, 'missing #endif']]);
    expect([...out.byUri.values()].flat().some((d) => /generated/.test(d.message))).toBe(false);
  });
});

describe('store merge of undeclared identifiers', () => {
  it('a colliding glslang error upgrades the fast warning to an Error and keeps its quick-fix data', () => {
    const store = new DiagnosticStore();
    const range = { start: { line: 1, character: 11 }, end: { line: 1, character: 13 } };
    store.setFast(uri('m.glsl'), [{ range, severity: 2, code: 'undeclared-identifier', message: "Undeclared identifier 'fa'.", data: { name: 'fa' } }]);
    store.setGlslang(uri('m.glsl'), new Map([[uri('m.glsl'), [{ range, severity: 1, source: 'glslang', code: 'glslang', message: "no matching overloaded function found ('fa')" }]]]));
    const merged = store.merged(uri('m.glsl'));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ severity: 1, code: 'undeclared-identifier', data: { name: 'fa' } });
    expect(store.hasUndeclared(uri('m.glsl'))).toBe(true);
  });

  it.skipIf(!GLSLANG)('calling an undefined function is an Error end to end', async () => {
    const text = 'void mainImage(out vec4 c, in vec2 fc) {\n  c = vec4(fa());\n}\n';
    const { ws } = makeWorkspace({ 'main.glsl': text });
    const store = new DiagnosticStore();
    store.setFast(uri('main.glsl'), computeFastDiagnostics(ws, uri('main.glsl')));
    const out = await computeGlslangDiagnostics(ws, uri('main.glsl'), { shadertoy: true, run: realRun });
    if (out.kind === 'done') store.setGlslang(uri('main.glsl'), out.byUri);
    const merged = store.merged(uri('main.glsl'));
    expect(merged.filter((d) => d.severity === 1).length).toBe(1);
    expect(merged.find((d) => d.code === 'undeclared-identifier')?.severity).toBe(1);
  });
});
