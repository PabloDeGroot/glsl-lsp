// Runs the diagnostics against a real shader workspace (see realWorkspace.ts;
// skipped without one) and checks that code that compiles gets no reports.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getBuiltins } from '../server/src/builtins';
import { fsPathToUri, NodeFileSystem, Workspace } from '../server/src/core';
import { computeFastDiagnostics, computeGlslangDiagnostics, runGlslang } from '../server/src/features/diagnostics';
import { REAL_EXCLUDE, REAL_ROOT, isEntryShader, realShaderFiles } from './realWorkspace';

const GLSLANG = spawnSync('glslangValidator', ['--version']).status === 0;
const FILES = realShaderFiles();

function indexReal(): Workspace {
  const ws = new Workspace({ fs: new NodeFileSystem(), builtins: getBuiltins(), roots: [fsPathToUri(REAL_ROOT!)], exclude: REAL_EXCLUDE });
  ws.indexWorkspaceSync();
  return ws;
}

describe.skipIf(!REAL_ROOT || !FILES.length)('diagnostics on a real shader workspace', () => {
  it.skipIf(!GLSLANG)('glslangValidator accepts every entry shader whose includes resolve', async () => {
    const ws = indexReal();
    const out: string[] = [];
    for (const rel of FILES) {
      if (!isEntryShader(readFileSync(join(REAL_ROOT!, rel), 'utf8'))) continue;
      const uri = fsPathToUri(join(REAL_ROOT!, rel));
      // A missing include target is a real problem of the shader, reported as such: not this test's concern.
      if (computeFastDiagnostics(ws, uri).some((d) => d.code === 'unresolved-include')) continue;
      const res = await computeGlslangDiagnostics(ws, uri, { run: (s, st) => runGlslang(s, { exe: 'glslangValidator', stage: st }) });
      if (res.kind === 'done') {
        for (const [u, ds] of res.byUri) for (const d of ds) out.push(`${rel} -> ${u.split('/').slice(-2).join('/')}:${d.range.start.line + 1} ${d.message}`);
      } else out.push(`${rel}: ${res.kind}`);
    }
    if (out.length) console.log(out.join('\n'));
    // Buffers without an entry point of their own are skipped, never reported.
    expect(out.filter((l) => !l.endsWith(': skipped'))).toEqual([]);
  });

  it('the fast checks report nothing on its shaders and libraries', () => {
    const ws = indexReal();
    const report: string[] = [];
    for (const rel of FILES) {
      const t0 = performance.now();
      const diags = computeFastDiagnostics(ws, fsPathToUri(join(REAL_ROOT!, rel)));
      const ms = performance.now() - t0;
      for (const d of diags.filter((x) => x.code !== 'unresolved-include')) report.push(`${rel}:${d.range.start.line + 1} [${d.code}] ${d.message}`);
      expect(ms).toBeLessThan(500);
    }
    if (report.length) console.log(report.join('\n'));
    expect(report).toEqual([]);
  });
});
