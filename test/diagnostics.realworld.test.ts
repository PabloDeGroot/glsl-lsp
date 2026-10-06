// Runs the diagnostics against the user's real shaders (parent workspace) and
// checks the fast checks do not report anything on code known to compile.
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getBuiltins } from '../server/src/builtins';
import { fsPathToUri, NodeFileSystem, Workspace } from '../server/src/core';
import { spawnSync } from 'node:child_process';
import { computeFastDiagnostics, computeGlslangDiagnostics, runGlslang } from '../server/src/features/diagnostics';

const PARENT = resolve(__dirname, '..', '..');
const HAS_PARENT = existsSync(resolve(PARENT, 'lygia')) && existsSync(resolve(PARENT, 'lib', 'common.glsl'));

const GLSLANG = spawnSync('glslangValidator', ['--version']).status === 0;

describe.skipIf(!HAS_PARENT)('diagnostics on the real shaders', () => {
  it.skipIf(!GLSLANG)('glslang accepts every user shader that has mainImage', async () => {
    const ws = new Workspace({ fs: new NodeFileSystem(), builtins: getBuiltins(), roots: [fsPathToUri(PARENT)], exclude: ['node_modules', '.git', 'out', 'dist', 'glsl-lsp', 'lygia', 'extension'] });
    ws.indexWorkspaceSync();
    const out: string[] = [];
    for (const dir of ['.', 'eyes-curl', 'eyes-fluid', 'eyes-network', 'glass', 'tiles']) {
      const full = resolve(PARENT, dir);
      if (!existsSync(full)) continue;
      for (const f of readdirSync(full).filter((n) => n.endsWith('.glsl'))) {
        const uri = fsPathToUri(resolve(full, f));
        const res = await computeGlslangDiagnostics(ws, uri, { shadertoy: true, run: (s, st) => runGlslang(s, { exe: 'glslangValidator', stage: st }) });
        if (res.kind === 'done') {
          for (const [u, ds] of res.byUri) for (const d of ds) out.push(`${dir}/${f} -> ${u.split('/').slice(-2).join('/')}:${d.range.start.line + 1} ${d.message}`);
        } else out.push(`${dir}/${f}: ${res.kind}`);
      }
    }
    if (out.length) console.log(out.join('\n'));
    // Library-like buffers without mainImage (eyes-fluid/common.glsl) are skipped, never reported.
    expect(out.filter((l) => !l.endsWith(': skipped'))).toEqual([]);
  });

  it('reports nothing on the user shaders and libraries', () => {
    const ws = new Workspace({ fs: new NodeFileSystem(), builtins: getBuiltins(), roots: [fsPathToUri(PARENT)], exclude: ['node_modules', '.git', 'out', 'dist', 'glsl-lsp', 'lygia', 'extension'] });
    ws.indexWorkspaceSync();
    const targets: string[] = [];
    for (const dir of ['.', 'lib', 'eyes-curl', 'eyes-fluid', 'eyes-network', 'glass', 'tiles']) {
      const full = resolve(PARENT, dir);
      if (!existsSync(full)) continue;
      for (const f of readdirSync(full)) if (f.endsWith('.glsl')) targets.push(resolve(full, f));
    }
    expect(targets.length).toBeGreaterThan(5);
    const report: string[] = [];
    for (const t of targets) {
      const t0 = performance.now();
      const diags = computeFastDiagnostics(ws, fsPathToUri(t));
      const ms = performance.now() - t0;
      for (const d of diags.filter((x) => x.code !== 'unresolved-include')) report.push(`${t.slice(PARENT.length)}:${d.range.start.line + 1} [${d.code}] ${d.message}`);
      expect(ms).toBeLessThan(500);
    }
    if (report.length) console.log(report.join('\n'));
    expect(report).toEqual([]);
  });
});
