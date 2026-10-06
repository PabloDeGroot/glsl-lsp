// glslangValidator integration: run the tool, parse its output, map messages
// from the flattened translation unit back to the original files.

import { spawn } from 'node:child_process';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { Range } from '../../core';
import type { Flattened, LineOrigin } from './flatten';

export const GLSLANG_SOURCE = 'glslang';

// ---------------------------------------------------------------- parsing

export interface GlslangMessage {
  severity: 'error' | 'warning';
  /** 1-based line in the flattened source; -1/0 when the tool gave none. */
  line: number;
  /** Text after the location, e.g. `'foo' : undeclared identifier`. */
  text: string;
}

const MISSING_ENDIF_RE = /^'' : missing #endif/;
const MESSAGE_RE = /^(ERROR|WARNING):\s*([^:\s]+):(-?\d+):\s*(.*?)\s*$/;

export function parseGlslangOutput(output: string): GlslangMessage[] {
  const out: GlslangMessage[] = [];
  // After a fatal error glslang stops reading and reports every still-open #if
  // (including the synthetic include guards of the flattened unit) as 'missing #endif'.
  const terminated = /'' : compilation terminated/.test(output);
  for (const raw of output.split(/\r?\n/)) {
    const m = MESSAGE_RE.exec(raw);
    if (!m) continue;
    const text = m[4];
    if (/^'' : compilation terminated/.test(text)) continue; // pure noise after a real error
    if (terminated && MISSING_ENDIF_RE.test(text)) continue;
    out.push({ severity: m[1] === 'ERROR' ? 'error' : 'warning', line: Number(m[3]), text });
  }
  return out;
}

/** Splits `'token' : message` into its parts. */
export function splitToken(text: string): { token?: string; message: string } {
  const m = /^'([^']*)'\s*:\s*(.*)$/.exec(text);
  if (!m) return { message: text };
  return { token: m[1] || undefined, message: m[2] };
}

// ---------------------------------------------------------------- mapping

export interface MappedDiagnostics {
  /** uri -> diagnostics located in that file. */
  byUri: Map<string, Diagnostic[]>;
}

export interface MapContext {
  rootUri: string;
  flattened: Flattened;
  /** Text of the original file (to find tokens within a line). */
  lineText(uri: string, line: number): string | undefined;
  /** Display path of a uri for summary messages. */
  displayPath(uri: string): string;
}

function severityOf(s: 'error' | 'warning'): DiagnosticSeverity {
  return s === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
}

/** Range of `token` within the line, else the whole trimmed line. */
export function rangeOnLine(text: string | undefined, line: number, token?: string): Range {
  const t = text ?? '';
  if (token) {
    const re = new RegExp(`(?<![\\w])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`);
    const m = re.exec(t);
    if (m) return { start: { line, character: m.index }, end: { line, character: m.index + token.length } };
    const idx = t.indexOf(token);
    if (idx >= 0) return { start: { line, character: idx }, end: { line, character: idx + token.length } };
  }
  const start = t.search(/\S/);
  const end = t.replace(/\s+$/, '').length;
  if (start < 0) return { start: { line, character: 0 }, end: { line, character: 0 } };
  return { start: { line, character: start }, end: { line, character: end } };
}

export function mapGlslangMessages(messages: GlslangMessage[], ctx: MapContext): MappedDiagnostics {
  const byUri = new Map<string, Diagnostic[]>();
  const push = (uri: string, d: Diagnostic) => {
    let list = byUri.get(uri);
    if (!list) byUri.set(uri, (list = []));
    list.push(d);
  };
  const { lineMap } = ctx.flattened;
  const seen = new Set<string>();

  // A real unclosed #if is reported at the end of the unit (a generated line):
  // report it on the user's opening directive(s) instead.
  const relocated: GlslangMessage[] = [];
  for (const msg of messages) {
    if (MISSING_ENDIF_RE.test(msg.text) && ctx.flattened.unclosedConditionals?.length) {
      for (const line of ctx.flattened.unclosedConditionals) relocated.push({ ...msg, line });
    } else relocated.push(msg);
  }

  for (const msg of relocated) {
    const { token, message } = splitToken(msg.text);
    const origin: LineOrigin | undefined = msg.line >= 1 ? lineMap[msg.line - 1] : undefined;
    // Generated lines (preamble / main wrapper) or no location: attach to the top of the root file.
    const target = origin ?? { uri: ctx.rootUri, line: 0 };
    const generated = !origin;
    const range = generated
      ? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
      : rangeOnLine(ctx.lineText(target.uri, target.line), target.line, token);
    const key = `${target.uri}|${range.start.line}|${range.start.character}|${msg.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    push(target.uri, {
      range,
      severity: severityOf(msg.severity),
      source: GLSLANG_SOURCE,
      code: 'glslang',
      message: `${message}${token ? ` ('${token}')` : ''}${generated ? ' (in generated Shadertoy wrapper)' : ''}`,
    });

    // Errors inside an included file: also summarize on the root's #include line.
    if (origin && origin.uri !== ctx.rootUri && origin.via) {
      const via = origin.via;
      const where = `${ctx.displayPath(origin.uri)}:${origin.line + 1}`;
      const sumKey = `${ctx.rootUri}|include|${via.line}|${where}|${message}`;
      if (!seen.has(sumKey)) {
        seen.add(sumKey);
        push(ctx.rootUri, {
          range: via.pathRange,
          severity: severityOf(msg.severity),
          source: GLSLANG_SOURCE,
          code: 'glslang-included',
          message: `${msg.severity === 'error' ? 'Error' : 'Warning'} in included file ${where}: ${message}`,
          relatedInformation: [{ location: { uri: origin.uri, range }, message }],
        });
      }
    }
  }
  return { byUri };
}

// ---------------------------------------------------------------- running

export type GlslangRun =
  | { ok: true; output: string; exitCode: number | null }
  | { ok: false; reason: 'missing' | 'timeout' | 'aborted' | 'failed'; detail?: string };

export interface RunOptions {
  exe: string;
  stage: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function runGlslang(source: string, options: RunOptions): Promise<GlslangRun> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) return resolve({ ok: false, reason: 'aborted' });
    let settled = false;
    let output = '';
    const finish = (r: GlslangRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      const args = ['--stdin', '-S', options.stage];
      // Node refuses to spawn .cmd/.bat wrappers without a shell (CVE-2024-27980 hardening).
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.exe)) {
        child = spawn(`"${options.exe}"`, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: true });
      } else {
        child = spawn(options.exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      }
    } catch (err) {
      // Cannot be started at all (EINVAL, bad path...): handled like a missing executable.
      return resolve({ ok: false, reason: 'missing', detail: String(err) });
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: 'timeout' });
    }, options.timeoutMs ?? 5000);
    const onAbort = () => {
      child.kill();
      finish({ ok: false, reason: 'aborted' });
    };
    options.signal?.addEventListener('abort', onAbort);
    child.stdout?.on('data', (b) => (output += b.toString()));
    child.stderr?.on('data', (b) => (output += b.toString()));
    child.on('error', (err: NodeJS.ErrnoException) => {
      const cannotStart = ['ENOENT', 'EACCES', 'EINVAL', 'EPERM', 'UNKNOWN', 'ENOEXEC'].includes(err.code ?? '');
      finish({ ok: false, reason: cannotStart ? 'missing' : 'failed', detail: err.message });
    });
    child.on('close', (code) => finish({ ok: true, output, exitCode: code }));
    child.stdin?.on('error', () => undefined); // EPIPE when the process dies early
    child.stdin?.end(source);
  });
}
