// End-to-end smoke test: spawns the bundled server (dist/server.js) over
// stdio, exactly as VS Code would, with a real shader workspace as its
// workspace folder (GLSL_LSP_E2E_ROOT, or this repository's parent directory
// when it looks like one, e.g. a folder with LYGIA; see ../realWorkspace.ts).
// Skipped without one. Most checks run on unsaved scratch buffers inside that
// folder (never written to disk); LYGIA checks need a lygia/ folder there.
//
// Run just this file with: npx vitest run test/e2e

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import type {
  CompletionItem,
  CompletionList,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkupContent,
  PublishDiagnosticsParams,
  SemanticTokens,
  SignatureHelp,
  TextEdit,
} from 'vscode-languageserver-protocol';
import { URI } from 'vscode-uri';
import { VALUE_TARGETS_REQUEST, type ValueTargetsResult } from '../../shared/valuesProtocol';
import { applyEdits } from '../formatHelpers';
import { isEntryShader, REAL_LYGIA, REAL_ROOT, REPO, realShaderFiles } from '../realWorkspace';

const ROOT = REAL_ROOT ?? '';
const enabled = !!REAL_ROOT;

/** The workspace's own entry shaders (mainImage or main), relative to ROOT. */
const SHADERS = enabled ? realShaderFiles().filter((f) => isEntryShader(readFileSync(join(ROOT, f), 'utf8'))) : [];

/** Scratch buffers: opened in the server, never written to disk. */
const SCRATCH = '__glsl_lsp_e2e__.glsl';
const SCRATCH_TEXT = [
  '// Centered and aspect corrected: y spans [-1, 1].',
  'vec2 uvCentered(vec2 fragCoord, vec2 res) { return (fragCoord * 2.0 - res) / res.y; }',
  '',
  '// Rotation matrix.',
  'mat2 rotate2d(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }',
  '',
  '// Overall speed.',
  '#iUniform float u_speed = 1.0 in { 0.0, 4.0 }',
  '#iUniform color3 u_tint = color3(1.0, 0.78, 0.55)',
  '',
  'void mainImage(out vec4 fragColor, in vec2 fragCoord) {',
  '    vec2 uv = uvCentered(fragCoord, iResolution.xy);',
  '    float t = iTime * u_speed;',
  '    uv *= rotate2d(-t * 0.25);',
  '    float d = length(uv - vec2(0.42, 0.26));',
  '    fragColor = vec4(u_tint * d, 1.0);',
  '}',
  '',
].join('\n');

const uriOf = (rel: string) => URI.file(join(ROOT, rel)).toString();
const textOf = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function positionOf(text: string, needle: string, from = 0, delta = 0) {
  const offset = text.indexOf(needle, from);
  if (offset < 0) throw new Error(`'${needle}' not found`);
  const before = text.slice(0, offset + delta).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}

const markdown = (h: Hover | null): string => (h ? (h.contents as MarkupContent).value ?? String(h.contents) : '');

describe.skipIf(!enabled)('language server end to end (real workspace)', () => {
  let proc: ChildProcess;
  let conn: MessageConnection;
  const logs: string[] = [];
  const diagnostics = new Map<string, Diagnostic[]>();
  let lastDiagnosticsAt = 0;
  let indexMs = -1;
  /** What workspace/configuration answers for the glslLsp section. */
  let config: Record<string, unknown> = {};

  async function waitFor(cond: () => boolean, timeoutMs: number, what: string) {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  function open(rel: string, text = textOf(rel), version = 1) {
    conn.sendNotification('textDocument/didOpen', { textDocument: { uri: uriOf(rel), languageId: 'glsl', version, text } });
  }

  const hover = async (rel: string, position: { line: number; character: number }) =>
    markdown(await conn.sendRequest<Hover | null>('textDocument/hover', { textDocument: { uri: uriOf(rel) }, position }));

  beforeAll(async () => {
    // GLSL_LSP_E2E_NO_BUILD=1 tests the dist/server.js already there (e.g. the minified `vscode:prepublish` build).
    if (!process.env.GLSL_LSP_E2E_NO_BUILD) execSync('node scripts/build.mjs', { cwd: REPO, stdio: 'ignore' });
    proc = spawn(process.execPath, [join(REPO, 'dist', 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stderr!.on('data', (d) => logs.push(`stderr: ${d}`));
    conn = createMessageConnection(new StreamMessageReader(proc.stdout!), new StreamMessageWriter(proc.stdin!));
    conn.onNotification('window/logMessage', (m: { message: string }) => logs.push(m.message));
    conn.onNotification('textDocument/publishDiagnostics', (p: PublishDiagnosticsParams) => {
      diagnostics.set(p.uri, p.diagnostics);
      lastDiagnosticsAt = Date.now();
    });
    conn.onRequest('workspace/configuration', (p: { items: unknown[] }) => p.items.map(() => config));
    conn.onRequest('client/registerCapability', () => null);
    conn.onRequest('window/workDoneProgress/create', () => null);
    conn.onRequest('workspace/inlayHint/refresh', () => null);
    conn.onRequest('workspace/semanticTokens/refresh', () => null);
    conn.listen();

    const rootUri = URI.file(ROOT).toString();
    const init = await conn.sendRequest<{ capabilities: Record<string, unknown> }>('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'shaders' }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { snippetSupport: true, resolveSupport: { properties: ['documentation', 'detail'] } } },
          publishDiagnostics: { relatedInformation: true },
        },
      },
      initializationOptions: { shaderToyInstalled: false },
    });
    expect(init.capabilities.hoverProvider).toBe(true);

    const t0 = Date.now();
    conn.sendNotification('initialized', {});
    await waitFor(() => logs.some((l) => /^Indexed \d+ GLSL files/.test(l)), 20_000, 'workspace index');
    indexMs = Date.now() - t0;
    const line = logs.find((l) => /^Indexed \d+ GLSL files/.test(l))!;
    console.log(`e2e: ${line} (wall clock from 'initialized': ${indexMs} ms)`);
    open(SCRATCH, SCRATCH_TEXT);
  }, 60_000);

  afterAll(async () => {
    try {
      await conn?.sendRequest('shutdown');
      conn?.sendNotification('exit');
    } catch {
      // already gone
    }
    await sleep(100);
    proc?.kill();
  });

  // The server reports its own indexing time; the wall clock includes process start-up and,
  // in the full suite, competes with the other test files for CPU. The ceilings are generous
  // (override with GLSL_LSP_E2E_INDEX_MS) and both figures are logged above.
  it('indexes the workspace quickly', () => {
    const reported = Number(/in (\d+) ms/.exec(logs.find((l) => /^Indexed \d+ GLSL files/.test(l)) ?? '')?.[1] ?? NaN);
    const ceiling = Number(process.env.GLSL_LSP_E2E_INDEX_MS ?? 15_000);
    console.log(`e2e: index ${reported} ms reported by the server, ${indexMs} ms wall clock (ceiling ${ceiling} ms)`);
    expect(indexMs).toBeGreaterThan(0);
    expect(reported).toBeLessThan(ceiling);
    expect(indexMs).toBeLessThan(ceiling);
  });

  it('hover shows // doc comments', async () => {
    const md = await hover(SCRATCH, positionOf(SCRATCH_TEXT, 'uvCentered(fragCoord', 0, 2));
    expect(md).toContain('vec2 uvCentered(vec2 fragCoord, vec2 res)');
    expect(md).toContain('Centered and aspect corrected');
  });

  it.skipIf(!REAL_LYGIA)('hover shows the YAML description of a LYGIA function', async () => {
    const rel = '__glsl_lsp_e2e_lygia__.glsl';
    const text = '#include "lygia/generative/gnoise.glsl"\n\nvoid mainImage(out vec4 c, in vec2 f) { c = vec4(gnoise(f)); }\n';
    open(rel, text);
    const md = await hover(rel, positionOf(text, 'gnoise(f)', 0, 1));
    expect(md).toContain('gnoise');
    expect(md).toMatch(/Gradient Noise/i);
    conn.sendNotification('textDocument/didClose', { textDocument: { uri: uriOf(rel) } });
  });

  it.skipIf(!REAL_LYGIA)('completion offers a not-yet-included LYGIA function with its #include edit', async () => {
    const anchor = SCRATCH_TEXT.indexOf('\n', SCRATCH_TEXT.indexOf('float t = iTime')) + 1;
    const edited = SCRATCH_TEXT.slice(0, anchor) + '    float vv = voron\n' + SCRATCH_TEXT.slice(anchor);
    conn.sendNotification('textDocument/didChange', { textDocument: { uri: uriOf(SCRATCH), version: 2 }, contentChanges: [{ text: edited }] });
    const position = positionOf(edited, 'float vv = voron', 0, 'float vv = voron'.length);
    const list = await conn.sendRequest<CompletionList | CompletionItem[] | null>('textDocument/completion', {
      textDocument: { uri: uriOf(SCRATCH) },
      position,
      context: { triggerKind: 1 },
    });
    const items = Array.isArray(list) ? list : list?.items ?? [];
    const item = items.find((i) => i.label === 'voronoi');
    expect(item, `labels: ${items.slice(0, 20).map((i) => i.label).join(', ')}`).toBeDefined();
    expect(item!.additionalTextEdits?.[0]?.newText).toContain('#include "lygia/generative/voronoi.glsl"');

    const resolved = await conn.sendRequest<CompletionItem>('completionItem/resolve', item);
    const doc = typeof resolved.documentation === 'string' ? resolved.documentation : resolved.documentation?.value ?? '';
    expect(doc.toLowerCase()).toContain('voronoi');

    conn.sendNotification('textDocument/didChange', { textDocument: { uri: uriOf(SCRATCH), version: 3 }, contentChanges: [{ text: SCRATCH_TEXT }] });
  });

  it('go to definition jumps to the declaration', async () => {
    const defs = await conn.sendRequest<Location | Location[] | LocationLink[] | null>('textDocument/definition', {
      textDocument: { uri: uriOf(SCRATCH) },
      position: positionOf(SCRATCH_TEXT, 'uvCentered(fragCoord', 0, 3),
    });
    const first = Array.isArray(defs) ? defs[0] : defs;
    const target = first && ('targetUri' in first ? first.targetUri : first.uri);
    const range = first && ('targetSelectionRange' in first ? first.targetSelectionRange : first.range);
    expect(target?.toLowerCase()).toBe(uriOf(SCRATCH).toLowerCase());
    expect(range?.start.line).toBe(1);
  });

  it('signature help lists the parameters of a user function', async () => {
    const help = await conn.sendRequest<SignatureHelp | null>('textDocument/signatureHelp', {
      textDocument: { uri: uriOf(SCRATCH) },
      position: positionOf(SCRATCH_TEXT, 'uvCentered(fragCoord', 0, 'uvCentered('.length),
    });
    expect(help?.signatures[help.activeSignature ?? 0]?.label).toContain('uvCentered(vec2 fragCoord');
  });

  it('document symbols and semantic tokens are non-empty', async () => {
    const symbols = await conn.sendRequest<DocumentSymbol[]>('textDocument/documentSymbol', { textDocument: { uri: uriOf(SCRATCH) } });
    expect(symbols.map((s) => s.name)).toContain('mainImage');
    const tokens = await conn.sendRequest<SemanticTokens>('textDocument/semanticTokens/full', { textDocument: { uri: uriOf(SCRATCH) } });
    expect(tokens.data.length).toBeGreaterThan(50);
    expect(tokens.data.length % 5).toBe(0);
  });

  it('formats documents: whole file, range and on type, with minimal edits', async () => {
    const rel = '__glsl_lsp_e2e_format__.glsl';
    const text = ['void f() {', 'float a=1.0;   ', '  if (a > 0.0) {', 'float b    = 2.0;', '}', '}'].join('\n');
    open(rel, text);
    const options = { tabSize: 4, insertSpaces: true };
    const textDocument = { uri: uriOf(rel) };
    const edits = await conn.sendRequest<TextEdit[]>('textDocument/formatting', { textDocument, options });
    expect(applyEdits(text, edits)).toBe(['void f() {', '    float a = 1.0;', '    if (a > 0.0) {', '        float b    = 2.0;', '    }', '}', ''].join('\n'));
    expect(edits.every((e) => e.range.start.line === e.range.end.line)).toBe(true);
    const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } };
    const rangeEdits = await conn.sendRequest<TextEdit[]>('textDocument/rangeFormatting', { textDocument, range, options });
    expect(applyEdits(text, rangeEdits).split('\n')[3]).toBe('        float b    = 2.0;');
    expect(applyEdits(text, rangeEdits).split('\n')[1]).toBe('float a=1.0;   ');
    const typed = await conn.sendRequest<TextEdit[]>('textDocument/onTypeFormatting', { textDocument, position: { line: 4, character: 1 }, ch: '}', options });
    expect(applyEdits(text, typed).split('\n')[4]).toBe('    }');
    conn.sendNotification('textDocument/didClose', { textDocument });
  });

  it('valid shaders produce no errors (fast checks + glslangValidator)', async () => {
    for (const rel of SHADERS) open(rel);
    // Fast checks publish immediately, glslang a moment later: wait until every file is published and things go quiet.
    await waitFor(() => [SCRATCH, ...SHADERS].every((r) => diagnostics.has(uriOf(r))), 30_000, 'diagnostics for every shader');
    await waitFor(() => Date.now() - lastDiagnosticsAt > 2000, 30_000, 'diagnostics to settle');

    const problems: string[] = [];
    for (const rel of [SCRATCH, ...SHADERS]) {
      const ds = diagnostics.get(uriOf(rel)) ?? [];
      // A missing include target is a real problem of that shader (reported as such), not a false positive.
      if (ds.some((d) => d.code === 'unresolved-include')) continue;
      for (const d of ds) {
        if (d.severity === 1 || d.code === 'undeclared-identifier') problems.push(`${rel}:${d.range.start.line + 1} [${d.source}/${d.code ?? ''}] ${d.message}`);
      }
    }
    const warnings = SHADERS.flatMap((rel) => (diagnostics.get(uriOf(rel)) ?? []).filter((d) => d.severity !== 1).map((d) => `${rel}:${d.range.start.line + 1} ${d.message}`));
    if (warnings.length) console.log(`e2e: non-error diagnostics:\n  ${warnings.join('\n  ')}`);
    expect(problems).toEqual([]);
  }, 90_000);

  it('glslangValidator errors are reported on the right line (unsaved buffer)', async () => {
    const rel = '__glsl_lsp_e2e_error__.glsl';
    const text = ['void mainImage(out vec4 fragColor, in vec2 fragCoord) {', '    vec2 uv = fragCoord / iResolution.xy;', '    vec3 c = uv;', '    fragColor = vec4(c, 1.0);', '}', ''].join('\n');
    diagnostics.delete(uriOf(rel));
    open(rel, text);
    await waitFor(() => (diagnostics.get(uriOf(rel)) ?? []).some((d) => d.severity === 1), 20_000, 'glslang error');
    const errors = diagnostics.get(uriOf(rel))!.filter((d) => d.severity === 1);
    expect(errors.map((d) => d.range.start.line)).toContain(2);
    conn.sendNotification('textDocument/didClose', { textDocument: { uri: uriOf(rel) } });
  }, 30_000);

  // ---------------------------------------------------------------- environment and Shadertoy mode

  describe('environment settings and the shader-toy extension, without a restart', () => {
    const rel = '__glsl_lsp_e2e_env__.glsl';
    const text = ['#version 300 es', 'precision highp float;', 'out vec4 color;', 'void main() {', '    color = vec4(iCursorTrail[0], iTime, float(MAX_LIGHTS));', '}', ''].join('\n');
    const undeclared = () => (diagnostics.get(uriOf(rel)) ?? []).filter((d) => d.code === 'undeclared-identifier').map((d) => (d.data as { name: string }).name).sort();

    it('a plain GLSL file reports runtime names until they are configured', async () => {
      diagnostics.delete(uriOf(rel));
      open(rel, text);
      await waitFor(() => undeclared().length === 3, 20_000, 'undeclared runtime names');
      // A plain entry shader (it defines main) is not Shadertoy under 'auto': iTime is undeclared too.
      expect(undeclared()).toEqual(['MAX_LIGHTS', 'iCursorTrail', 'iTime']);

      config = { environment: { uniforms: [{ name: 'iCursorTrail', type: 'vec2[8]', doc: 'Last cursor positions.' }], defines: { MAX_LIGHTS: '8' } } };
      conn.sendNotification('workspace/didChangeConfiguration', { settings: null });
      await waitFor(() => undeclared().length === 1, 20_000, 'environment applied');
      expect(undeclared()).toEqual(['iTime']);
      const md = await hover(rel, positionOf(text, 'iCursorTrail', 0, 2));
      expect(md).toContain('*Environment uniform*');
      expect(md).toContain('Last cursor positions.');
    }, 45_000);

    it("'auto' Shadertoy mode follows the client's shader-toy extension report", async () => {
      expect(await hover(rel, positionOf(text, 'iTime', 0, 1))).toBe('');
      conn.sendNotification('glslLsp/clientEnvironment', { shaderToyInstalled: true });
      expect(await hover(rel, positionOf(text, 'iTime', 0, 1))).toContain('float iTime');
      await waitFor(() => undeclared().length === 0, 20_000, 'Shadertoy names declared with the extension installed');
      conn.sendNotification('glslLsp/clientEnvironment', { shaderToyInstalled: false });
      expect(await hover(rel, positionOf(text, 'iTime', 0, 1))).toBe('');
      await waitFor(() => undeclared().length === 1, 20_000, 'iTime undeclared again');

      config = { shadertoy: { enable: 'off' } };
      conn.sendNotification('workspace/didChangeConfiguration', { settings: null });
      await waitFor(() => undeclared().length === 3, 20_000, "Shadertoy 'off' and no environment");
      expect(undeclared()).toEqual(['MAX_LIGHTS', 'iCursorTrail', 'iTime']);
      config = {};
      conn.sendNotification('workspace/didChangeConfiguration', { settings: null });
      await waitFor(() => undeclared().length === 3, 20_000, 'defaults again');
      expect(undeclared()).toEqual(['MAX_LIGHTS', 'iCursorTrail', 'iTime']);
      conn.sendNotification('textDocument/didClose', { textDocument: { uri: uriOf(rel) } });
    }, 45_000);
  });

  // ---------------------------------------------------------------- Values panel (glslLsp/valueTargets)

  describe('Values panel: glslLsp/valueTargets', () => {
    const rel = SCRATCH;
    let version = 100;
    const sync = (text: string) => {
      version++;
      conn.sendNotification('textDocument/didChange', { textDocument: { uri: uriOf(rel), version }, contentChanges: [{ text }] });
      return version;
    };
    const at = (text: string, needle: string, delta = 0) => positionOf(text, needle, 0, delta);
    const cursor = async (text: string, needle: string, delta = 0) => {
      const r = await conn.sendRequest<ValueTargetsResult>(VALUE_TARGETS_REQUEST, { uri: uriOf(rel), position: at(text, needle, delta) });
      return r;
    };

    it('#iUniform float u_speed: float with its `in { min, max }` range', async () => {
      const text = SCRATCH_TEXT;
      const v = sync(text);
      const r = await cursor(text, '#iUniform float u_speed', '#iUniform float u_'.length);
      expect(r.version).toBe(v);
      const t = r.cursor!;
      expect(t).toBeTruthy();
      expect(t.kind).toBe('float');
      expect(t.name).toBe('u_speed');
      expect(t.declKind).toBe('iUniform');
      expect(t.uniform).toMatchObject({ declaredType: 'float', min: 0, max: 4 });
      expect(t.components).toHaveLength(1);
      expect(t.components[0]).toMatchObject({ value: 1, text: '1.0', editable: true });
      // The component range really covers the default literal in the document.
      const line = text.split(/\r?\n/)[t.components[0].range.start.line];
      expect(line.slice(t.components[0].range.start.character, t.components[0].range.end.character)).toBe('1.0');
      expect(t.uri.toLowerCase()).toBe(uriOf(rel).toLowerCase());
    });

    it('#iUniform color3 u_tint: colorish vec3 with three editable components', async () => {
      const r = await cursor(SCRATCH_TEXT, 'color3(1.0, 0.78, 0.55)', 'color3('.length + 6);
      const t = r.cursor!;
      expect(t.kind).toBe('vec3');
      expect(t.name).toBe('u_tint');
      expect(t.ctor).toBe('color3');
      expect(t.colorish).toBe(true);
      expect(t.uniform?.declaredType).toBe('color3');
      expect(t.components.map((c) => c.value)).toEqual([1, 0.78, 0.55]);
      expect(t.components.every((c) => c.editable)).toBe(true);
    });

    it('a plain float literal inside an expression', async () => {
      const r = await cursor(SCRATCH_TEXT, 'rotate2d(-t * 0.25)', 'rotate2d(-t * 0.2'.length);
      const t = r.cursor!;
      expect(t.kind).toBe('float');
      expect(t.uniform).toBeUndefined();
      expect(t.components[0]).toMatchObject({ value: 0.25, text: '0.25', editable: true });
    });

    it('a vec2 constructor argument', async () => {
      const r = await cursor(SCRATCH_TEXT, 'vec2(0.42, 0.26)', 2);
      const t = r.cursor!;
      expect(t.kind).toBe('vec2');
      expect(t.components.map((c) => c.value)).toEqual([0.42, 0.26]);
      expect(t.colorish).toBe(false);
    });

    it('pins re-resolve after lines are inserted above them, and go stale when removed', async () => {
      const text = SCRATCH_TEXT;
      const speed = (await cursor(text, '#iUniform float u_speed', '#iUniform float u_'.length)).cursor!;
      const lit = (await cursor(text, 'rotate2d(-t * 0.25)', 'rotate2d(-t * 0.2'.length)).cursor!;
      const anchors = [speed.anchor, lit.anchor];

      const shifted = '// one\n// two\n// three\n' + text;
      sync(shifted);
      const r = await conn.sendRequest<ValueTargetsResult>(VALUE_TARGETS_REQUEST, { uri: uriOf(rel), anchors });
      expect(r.anchors).toHaveLength(2);
      expect(r.anchors![0].match).toBe('declaration');
      expect(r.anchors![0].target?.range.start.line).toBe(speed.range.start.line + 3);
      expect(r.anchors![0].anchor.line).toBe(speed.anchor.line + 3);
      expect(r.anchors![1].match).not.toBe('none');
      expect(r.anchors![1].target?.components[0].value).toBe(0.25);
      expect(r.anchors![1].target?.range.start.line).toBe(lit.range.start.line + 3);

      // Remove the uniform line entirely: that pin is stale, the other still resolves.
      const removed = text.replace(/^#iUniform float u_speed.*\r?\n/m, '');
      sync(removed);
      const r2 = await conn.sendRequest<ValueTargetsResult>(VALUE_TARGETS_REQUEST, { uri: uriOf(rel), anchors });
      expect(r2.anchors![0].match).toBe('none');
      expect(r2.anchors![0].target).toBeNull();
      expect(r2.anchors![1].target?.components[0].value).toBe(0.25);

      sync(text);
    });

    it('unknown documents answer null instead of failing', async () => {
      const r = await conn.sendRequest<ValueTargetsResult>(VALUE_TARGETS_REQUEST, {
        uri: uriOf('__does_not_exist__.glsl'),
        position: { line: 0, character: 0 },
      });
      expect(r.cursor).toBeNull();
    });
  });
});
