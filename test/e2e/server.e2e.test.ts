// End-to-end smoke test: spawns the bundled server (dist/server.js) over
// stdio, exactly as VS Code would, against the real shader workspace that
// contains this repo (C:\Pablo\shader, or GLSL_LSP_E2E_ROOT). Skipped when
// that workspace is not present.
//
// Run just this file with: npx vitest run test/e2e

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
} from 'vscode-languageserver-protocol';
import { URI } from 'vscode-uri';

const REPO = resolve(__dirname, '..', '..');
const ROOT = process.env.GLSL_LSP_E2E_ROOT ?? resolve(REPO, '..');
const enabled = existsSync(join(ROOT, 'main.glsl')) && existsSync(join(ROOT, 'lib', 'common.glsl')) && existsSync(join(ROOT, 'lygia'));

/** Every shader the user previews (entry points), relative to ROOT. */
const SHADERS = [
  'main.glsl',
  'channels.glsl',
  'cubemap.glsl',
  'mask.glsl',
  'windows.glsl',
  'probe.glsl',
  'noise.glsl',
  'shader.glsl',
  'time.glsl',
  'eyes-curl/noisemouse.glsl',
  'eyes-curl/noisemouse_eyes.glsl',
  'eyes-curl/noisemouse_smoke.glsl',
  'eyes-fluid/common.glsl',
  'eyes-fluid/eyes.glsl',
  'eyes-fluid/image.glsl',
  'eyes-fluid/pressure.glsl',
  'eyes-fluid/smoke.glsl',
  'eyes-fluid/velocity.glsl',
  'eyes-network/eyes.glsl',
  'glass/noisemouse_eyes.glsl',
  'tiles/tiles.glsl',
].filter((f) => existsSync(join(ROOT, f)));

/**
 * Errors that are real problems in the user's shaders, not false positives
 * (the include target does not exist in LYGIA).
 */
const KNOWN_REAL_ERRORS: { file: string; message: RegExp }[] = [{ file: 'eyes-network/eyes.glsl', message: /windmill\.glsl/ }];

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
    conn.onRequest('workspace/configuration', (p: { items: unknown[] }) => p.items.map(() => ({})));
    conn.onRequest('client/registerCapability', () => null);
    conn.onRequest('window/workDoneProgress/create', () => null);
    conn.onRequest('workspace/inlayHint/refresh', () => null);
    conn.onRequest('workspace/semanticTokens/refresh', () => null);
    conn.listen();

    const rootUri = URI.file(ROOT).toString();
    const init = await conn.sendRequest<{ capabilities: Record<string, unknown> }>('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'shader' }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { snippetSupport: true, resolveSupport: { properties: ['documentation', 'detail'] } } },
          publishDiagnostics: { relatedInformation: true },
        },
      },
    });
    expect(init.capabilities.hoverProvider).toBe(true);

    const t0 = Date.now();
    conn.sendNotification('initialized', {});
    await waitFor(() => logs.some((l) => /^Indexed \d+ GLSL files/.test(l)), 20_000, 'workspace index');
    indexMs = Date.now() - t0;
    const line = logs.find((l) => /^Indexed \d+ GLSL files/.test(l))!;
    console.log(`e2e: ${line} (wall clock from 'initialized': ${indexMs} ms)`);
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

  it('hover shows // doc comments of a lib/ function', async () => {
    const text = textOf('main.glsl');
    open('main.glsl', text);
    const h = await conn.sendRequest<Hover | null>('textDocument/hover', {
      textDocument: { uri: uriOf('main.glsl') },
      position: positionOf(text, 'uvCentered(fragCoord', 0, 2),
    });
    const md = markdown(h);
    expect(md).toContain('vec2 uvCentered(vec2 fragCoord, vec2 res)');
    expect(md).toContain('Centered and aspect corrected');
  });

  it('hover shows the YAML description of a LYGIA function', async () => {
    const rel = 'eyes-curl/noisemouse_eyes.glsl';
    const text = textOf(rel);
    open(rel, text);
    const body = text.indexOf('#include "../lib/common.glsl"');
    const h = await conn.sendRequest<Hover | null>('textDocument/hover', {
      textDocument: { uri: uriOf(rel) },
      position: positionOf(text, 'gnoise(', body, 1),
    });
    const md = markdown(h);
    expect(md).toContain('gnoise');
    expect(md).toMatch(/Gradient Noise/i);
  });

  it('completion offers a not-yet-included LYGIA function with its #include edit', async () => {
    const text = textOf('main.glsl');
    const anchor = text.indexOf('\n', text.indexOf('float t = iTime')) + 1;
    const edited = text.slice(0, anchor) + '    float vv = voron\n' + text.slice(anchor);
    conn.sendNotification('textDocument/didChange', {
      textDocument: { uri: uriOf('main.glsl'), version: 2 },
      contentChanges: [{ text: edited }],
    });
    const position = positionOf(edited, 'float vv = voron', 0, 'float vv = voron'.length);
    const list = await conn.sendRequest<CompletionList | CompletionItem[] | null>('textDocument/completion', {
      textDocument: { uri: uriOf('main.glsl') },
      position,
      context: { triggerKind: 1 },
    });
    const items = Array.isArray(list) ? list : list?.items ?? [];
    const item = items.find((i) => i.label === 'voronoi');
    expect(item, `labels: ${items.slice(0, 20).map((i) => i.label).join(', ')}`).toBeDefined();
    const edit = item!.additionalTextEdits?.[0];
    expect(edit?.newText).toContain('#include "lygia/generative/voronoi.glsl"');
    // Goes right after the last existing #include (lib/sdf.glsl).
    expect(edit!.range.start.line).toBe(positionOf(text, '#include "lib/sdf.glsl"').line + 1);

    const resolved = await conn.sendRequest<CompletionItem>('completionItem/resolve', item);
    const doc = typeof resolved.documentation === 'string' ? resolved.documentation : resolved.documentation?.value ?? '';
    expect(doc.toLowerCase()).toContain('voronoi');

    conn.sendNotification('textDocument/didChange', {
      textDocument: { uri: uriOf('main.glsl'), version: 3 },
      contentChanges: [{ text }],
    });
  });

  it('go to definition jumps into lib/*.glsl', async () => {
    const text = textOf('main.glsl');
    const defs = await conn.sendRequest<Location | Location[] | LocationLink[] | null>('textDocument/definition', {
      textDocument: { uri: uriOf('main.glsl') },
      position: positionOf(text, 'uvCentered(fragCoord', 0, 3),
    });
    const first = Array.isArray(defs) ? defs[0] : defs;
    const target = first && ('targetUri' in first ? first.targetUri : first.uri);
    expect(target?.toLowerCase()).toBe(uriOf('lib/common.glsl').toLowerCase());
  });

  it('signature help lists the parameters of a lib/ function', async () => {
    const text = textOf('main.glsl');
    const help = await conn.sendRequest<SignatureHelp | null>('textDocument/signatureHelp', {
      textDocument: { uri: uriOf('main.glsl') },
      position: positionOf(text, 'uvCentered(fragCoord', 0, 'uvCentered('.length),
    });
    expect(help?.signatures[help.activeSignature ?? 0]?.label).toContain('uvCentered(vec2 fragCoord');
  });

  it('document symbols and semantic tokens are non-empty', async () => {
    const symbols = await conn.sendRequest<DocumentSymbol[]>('textDocument/documentSymbol', { textDocument: { uri: uriOf('main.glsl') } });
    expect(symbols.map((s) => s.name)).toContain('mainImage');
    const tokens = await conn.sendRequest<SemanticTokens>('textDocument/semanticTokens/full', { textDocument: { uri: uriOf('main.glsl') } });
    expect(tokens.data.length).toBeGreaterThan(50);
    expect(tokens.data.length % 5).toBe(0);
  });

  it('valid shaders produce no errors (fast checks + glslangValidator)', async () => {
    for (const rel of SHADERS) if (rel !== 'main.glsl' && rel !== 'eyes-curl/noisemouse_eyes.glsl') open(rel);
    // Fast checks publish immediately, glslang a moment later: wait until every file is published and things go quiet.
    await waitFor(() => SHADERS.every((r) => diagnostics.has(uriOf(r))), 30_000, 'diagnostics for every shader');
    await waitFor(() => Date.now() - lastDiagnosticsAt > 2000, 30_000, 'diagnostics to settle');

    const problems: string[] = [];
    for (const rel of SHADERS) {
      for (const d of diagnostics.get(uriOf(rel)) ?? []) {
        const known = KNOWN_REAL_ERRORS.some((k) => k.file === rel && k.message.test(d.message));
        const isUndeclared = d.code === 'undeclared-identifier';
        if (!known && (d.severity === 1 || isUndeclared)) problems.push(`${rel}:${d.range.start.line + 1} [${d.source}/${d.code ?? ''}] ${d.message}`);
      }
    }
    const warnings = SHADERS.flatMap((rel) => (diagnostics.get(uriOf(rel)) ?? []).filter((d) => d.severity !== 1).map((d) => `${rel}:${d.range.start.line + 1} ${d.message}`));
    if (warnings.length) console.log(`e2e: non-error diagnostics:\n  ${warnings.join('\n  ')}`);
    expect(problems).toEqual([]);
  }, 90_000);

  it('glslangValidator errors are reported on the right line (unsaved buffer)', async () => {
    const rel = '__e2e_scratch__.glsl';
    const text = [
      '#include "lib/common.glsl"',
      '',
      'void mainImage(out vec4 fragColor, in vec2 fragCoord) {',
      '    vec2 uv = uvCentered(fragCoord, iResolution.xy);',
      '    vec3 c = uv;',
      '    fragColor = vec4(c, 1.0);',
      '}',
      '',
    ].join('\n');
    diagnostics.delete(uriOf(rel));
    open(rel, text);
    await waitFor(() => (diagnostics.get(uriOf(rel)) ?? []).some((d) => d.severity === 1), 20_000, 'glslang error');
    const errors = diagnostics.get(uriOf(rel))!.filter((d) => d.severity === 1);
    expect(errors.map((d) => d.range.start.line)).toContain(4);
    conn.sendNotification('textDocument/didClose', { textDocument: { uri: uriOf(rel) } });
  }, 30_000);
});
