// Diagnostics: pushed with connection.sendDiagnostics.
//
//   fast checks     features/diagnostics/fast.ts     in-process, every run
//   glslang         features/diagnostics/glslang.ts  flattened source via glslangValidator
//   flattening      features/diagnostics/flatten.ts  includes + Shadertoy wrapper + line map
//   merging         features/diagnostics/store.ts    per-producer layers
//
// Scheduling: edits are debounced (~300 ms, glslLsp.diagnostics.onType),
// open and save validate immediately, a new run cancels the previous glslang
// process of the same file, and a change to an included file re-validates the
// open files that depend on it.

import type { Diagnostic } from 'vscode-languageserver/node';
import type { ServerContext } from '../context';
import { normalizeUri, type Workspace } from '../core';
import { computeFastDiagnostics, type FastOptions } from './diagnostics/fast';
import { flatten, planValidation } from './diagnostics/flatten';
import { mapGlslangMessages, parseGlslangOutput, runGlslang, type GlslangRun } from './diagnostics/glslang';
import { DiagnosticStore } from './diagnostics/store';

export { computeFastDiagnostics } from './diagnostics/fast';
export { flatten, planValidation } from './diagnostics/flatten';
export { mapGlslangMessages, parseGlslangOutput, runGlslang } from './diagnostics/glslang';
export { DiagnosticStore } from './diagnostics/store';

const DEBOUNCE_MS = 300;

export type Runner = (source: string, stage: string, signal?: AbortSignal) => Promise<GlslangRun>;

export type GlslangOutcome =
  | { kind: 'skipped' }
  | { kind: 'failed'; reason: 'missing' | 'timeout' | 'aborted' | 'failed'; detail?: string }
  | { kind: 'done'; byUri: Map<string, Diagnostic[]> };

/** Pure(ish) glslang validation of one root file; `run` is injectable for tests. */
export async function computeGlslangDiagnostics(
  ws: Workspace,
  uriIn: string,
  options: { /** Shadertoy support for this file; default: the workspace decides (Workspace.shadertoyActive). */ shadertoy?: boolean; run: Runner; signal?: AbortSignal },
): Promise<GlslangOutcome> {
  const uri = normalizeUri(uriIn);
  const model = ws.getModel(uri);
  if (!model) return { kind: 'skipped' };
  const plan = planValidation(model, options.shadertoy ?? ws.shadertoyActive(model));
  if (!plan) return { kind: 'skipped' };
  const flat = flatten(ws, uri, { shadertoy: plan.shadertoy, stage: plan.stage });
  const result = await options.run(flat.source, flat.stage, options.signal);
  if (!result.ok) return { kind: 'failed', reason: result.reason, detail: result.detail };
  const messages = parseGlslangOutput(result.output);
  // A non-zero exit without any parsed message is a broken run (crash, missing DLL,
  // a validator without --stdin), not a clean compile: keep the previous results.
  if (result.exitCode !== 0 && !messages.length) {
    return { kind: 'failed', reason: 'failed', detail: `exit code ${result.exitCode}: ${result.output.trim().slice(0, 500) || '(no output)'}` };
  }
  const { byUri } = mapGlslangMessages(messages, {
    rootUri: uri,
    flattened: flat,
    lineText: (u, line) => {
      const m = ws.peekModel(u) ?? ws.getModel(u);
      if (!m) return undefined;
      const starts = m.lines.lineStarts;
      if (line >= starts.length) return undefined;
      return m.text.slice(starts[line], starts[line + 1] ?? m.text.length).replace(/[\r\n]+$/, '');
    },
    displayPath: (u) => ws.displayPath(u),
  });
  byUri.set(uri, byUri.get(uri) ?? []);
  return { kind: 'done', byUri };
}

export function register(ctx: ServerContext): void {
  const store = new DiagnosticStore();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const controllers = new Map<string, AbortController>();
  const published = new Set<string>();
  let glslangDisabledForSession = false;
  let warnedMissing = false;
  let warnedFailed = false;

  const settings = () => ctx.settings.get();
  const enabled = () => settings().diagnostics.enable;

  const openUris = (): Map<string, string> => {
    const map = new Map<string, string>();
    for (const d of ctx.documents.all()) map.set(normalizeUri(d.uri), d.uri);
    return map;
  };

  function publish(uris: Iterable<string>) {
    const open = openUris();
    for (const u of new Set(uris)) {
      const clientUri = open.get(u);
      if (clientUri) {
        const diagnostics = enabled() ? store.merged(u) : [];
        published.add(u);
        void ctx.connection.sendDiagnostics({ uri: clientUri, version: ctx.documents.get(clientUri)?.version, diagnostics });
      } else if (published.has(u)) {
        published.delete(u);
        // closed documents: the client uri spelling is unknown, so rebuild it from the normalized one
        void ctx.connection.sendDiagnostics({ uri: u, diagnostics: [] });
      }
    }
  }

  function cancel(uri: string) {
    const t = timers.get(uri);
    if (t) clearTimeout(t);
    timers.delete(uri);
    controllers.get(uri)?.abort();
    controllers.delete(uri);
  }

  const run: Runner = (source, stage, signal) =>
    runGlslang(source, { exe: settings().diagnostics.glslang.path || 'glslangValidator', stage, signal, timeoutMs: 5000 });

  async function validate(uri: string) {
    timers.delete(uri);
    if (!ctx.documents.get(openUris().get(uri) ?? uri)) return;
    if (!enabled()) {
      publish([uri]); // clears what was shown before the setting changed
      return;
    }
    const fastOptions: FastOptions = { undeclared: settings().diagnostics.undeclared };
    try {
      publish(store.setFast(uri, computeFastDiagnostics(ctx.workspace, uri, fastOptions)));
    } catch (err) {
      ctx.log.error(`fast diagnostics failed for ${uri}: ${(err as Error).stack ?? err}`);
    }
    if (!settings().diagnostics.glslang.enable || glslangDisabledForSession) {
      publish(store.clearGlslang(uri));
      return;
    }
    controllers.get(uri)?.abort();
    const controller = new AbortController();
    controllers.set(uri, controller);
    try {
      const outcome = await computeGlslangDiagnostics(ctx.workspace, uri, {
        run: (s, st) => run(s, st, controller.signal),
        signal: controller.signal,
      });
      if (controller.signal.aborted || controllers.get(uri) !== controller) return; // stale
      controllers.delete(uri);
      if (outcome.kind === 'skipped') publish(store.clearGlslang(uri));
      else if (outcome.kind === 'done') publish(store.setGlslang(uri, outcome.byUri));
      else if (outcome.reason === 'missing') {
        glslangDisabledForSession = true;
        if (!warnedMissing) {
          warnedMissing = true;
          ctx.log.warn(`could not run glslangValidator: ${outcome.detail ?? ''}`);
          void ctx.connection.window.showWarningMessage(
            `glsl-lsp: could not run '${settings().diagnostics.glslang.path}'${outcome.detail ? ` (${outcome.detail})` : ''}. Install glslangValidator or set glslLsp.diagnostics.glslang.path. Compiler diagnostics are disabled until the setting changes.`,
          );
        }
      } else if (outcome.reason === 'timeout') {
        ctx.log.warn(`glslangValidator timed out for ${uri}`);
      } else if (outcome.reason === 'failed') {
        ctx.log.warn(`glslangValidator failed: ${outcome.detail ?? ''}`);
        if (!warnedFailed) {
          warnedFailed = true;
          void ctx.connection.window.showWarningMessage(
            `glsl-lsp: glslangValidator ('${settings().diagnostics.glslang.path}') did not run correctly: ${outcome.detail ?? 'unknown error'}. See the GLSL output channel.`,
          );
        }
      }
    } catch (err) {
      ctx.log.error(`glslang diagnostics failed for ${uri}: ${(err as Error).stack ?? err}`);
    }
  }

  function schedule(uri: string, delay: number) {
    const t = timers.get(uri);
    if (t) clearTimeout(t);
    // a pending edit makes a running glslang process stale
    if (delay > 0) controllers.get(uri)?.abort();
    timers.set(uri, setTimeout(() => void validate(uri), delay));
  }

  function scheduleDependents(uri: string, delay: number) {
    const open = openUris();
    for (const dep of ctx.workspace.transitiveIncluders(uri)) if (open.has(dep)) schedule(dep, delay);
  }

  function revalidateAll() {
    for (const u of openUris().keys()) schedule(u, 0);
  }

  ctx.documents.onDidOpen((e) => schedule(normalizeUri(e.document.uri), 0));
  ctx.documents.onDidSave((e) => {
    const uri = normalizeUri(e.document.uri);
    schedule(uri, 0);
    scheduleDependents(uri, 0);
  });
  ctx.documents.onDidClose((e) => {
    const uri = normalizeUri(e.document.uri);
    cancel(uri);
    const affected = store.clearDocument(uri);
    void ctx.connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
    published.delete(uri);
    publish(affected.filter((u) => u !== uri));
  });

  /** Fast checks only (no glslang run): the 'declared in X' hint depends on the whole workspace. */
  const fastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function scheduleFast(uri: string) {
    if (timers.has(uri) || fastTimers.has(uri)) return;
    fastTimers.set(
      uri,
      setTimeout(() => {
        fastTimers.delete(uri);
        if (!enabled() || !ctx.documents.get(openUris().get(uri) ?? uri)) return;
        try {
          publish(store.setFast(uri, computeFastDiagnostics(ctx.workspace, uri, { undeclared: settings().diagnostics.undeclared })));
        } catch (err) {
          ctx.log.error(`fast diagnostics failed for ${uri}: ${(err as Error).stack ?? err}`);
        }
      }, DEBOUNCE_MS),
    );
  }

  ctx.onModelChanged((e) => {
    const open = openUris();
    // onType=false only defers re-validation of edits to open buffers; disk changes
    // (watched files, deleted includes, re-resolved includes) still re-validate dependents.
    const bufferEdit = !e.fromDisk && open.has(e.uri);
    if (settings().diagnostics.onType || !bufferEdit) {
      for (const u of e.affected) if (open.has(u)) schedule(u, DEBOUNCE_MS);
    }
    if (e.namesChanged) {
      const affected = new Set(e.affected);
      for (const u of open.keys()) if (!affected.has(u) && store.hasUndeclared(u)) scheduleFast(u);
    }
  });

  ctx.onIndexed(revalidateAll);
  // The shader-toy extension was installed or removed (settings changes are handled below).
  ctx.onEnvironmentChanged((reason) => {
    if (reason === 'client') revalidateAll();
  });

  ctx.settings.onDidChange((s, prev) => {
    if (s.diagnostics.glslang.path !== prev.diagnostics.glslang.path || s.diagnostics.glslang.enable !== prev.diagnostics.glslang.enable) {
      glslangDisabledForSession = false;
      warnedMissing = false;
      warnedFailed = false;
    }
    revalidateAll();
  });
}
