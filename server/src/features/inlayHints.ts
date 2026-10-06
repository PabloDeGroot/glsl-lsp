// Inlay hints: `name:` labels in front of call arguments.
//
// glslLsp.inlayHints.parameterNames: 'none' | 'literals' (default) | 'all'.
// 'literals' only labels literal / constructor-like arguments (`rot(uv, 0.5)`
// -> `rot(uv, a: 0.5)`); identifiers usually name themselves. A legacy boolean
// is accepted (true = 'literals'). GLSL is explicitly typed, so there are no
// type hints.

import { InlayHintKind, MarkupKind, type InlayHint, type InlayHintParams } from 'vscode-languageserver/node';
import type { ServerContext } from '../context';
import { onDependentsChanged } from './refresh';
import { normalizeUri, type CallSite, type FileModel, type Workspace } from '../core';
import { inferArgType, pickActiveCandidate, resolveCallCandidates, type SigCandidate } from './signatureHelp';

export type ParameterNamesMode = 'none' | 'literals' | 'all';

export function parseMode(raw: unknown): ParameterNamesMode {
  if (raw === 'none' || raw === 'literals' || raw === 'all') return raw;
  if (raw === false) return 'none';
  return 'literals';
}

/** Builtin parameter names that say nothing more than the argument does. */
const OBVIOUS_BUILTIN_NAMES = new Set(['x', 'y', 'z', 'w', 'a', 'b', 'p', 'v', 'n', 'e', 'i', 't', 'u', 'f', 'm', 'q', 'r', 's', 'c']);

const LITERAL_RE = /^[+-]?\s*(?:(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fFuU]?|0[xX][0-9a-fA-F]+[uU]?|true|false)$/;
const CTOR_RE = /^[+-]?\s*[A-Za-z_]\w*\s*\(/;

/** A literal, a signed literal, or a constructor-like call (`vec2(1.0)`). */
export function isLiteralLike(text: string): boolean {
  const t = text.trim();
  return LITERAL_RE.test(t) || (CTOR_RE.test(t) && t.endsWith(')'));
}

/** True when the argument text already names the parameter (`uv` for `uv`, `p.uv`, `myUv` for `uv`). */
export function argNamesParam(argText: string, paramName: string): boolean {
  const a = argText.trim().toLowerCase();
  const p = paramName.toLowerCase();
  if (!p) return true;
  if (a === p) return true;
  const tail = identTail(a);
  return tail === p || (p.length >= 3 && tail.endsWith(p));
}

/** The last identifier of an access expression like `a.b.c` or `f(x)` -> `c` / `f(x)`. */
function identTail(text: string): string {
  return /([A-Za-z_]\w*)$/.exec(text)?.[1] ?? text;
}

export interface HintOptions {
  mode: ParameterNamesMode;
}

function hintForCall(ws: Workspace, model: FileModel, call: CallSite, mode: ParameterNamesMode, inRange: (offset: number) => boolean): InlayHint[] {
  if (call.isConstructor || !call.args.length) return [];
  const candidates = resolveCallCandidates(ws, model, call);
  if (!candidates.length) return [];

  const argSpans = call.args.map((r) => ({ start: model.lines.offsetAt(r.start), end: model.lines.offsetAt(r.end) }));
  if (!argSpans.some((s) => inRange(s.start))) return [];

  // Only candidates that fit the argument count are considered; the best by type match is used.
  const fitting = candidates.filter((c) => c.params.length >= call.args.length);
  if (!fitting.length) return [];
  const exact = fitting.filter((c) => c.params.length === call.args.length);
  const pool: SigCandidate[] = exact.length ? exact : fitting;
  const argTypes = argSpans.map((s) => inferArgType(ws, model, s));
  const chosen = pool[pickActiveCandidate(pool, argTypes, call.args.length - 1, call.args.length)];
  if (chosen.params.length < 2) return [];
  if (chosen.source === 'constructor') return [];

  const out: InlayHint[] = [];
  for (let i = 0; i < argSpans.length && i < chosen.params.length; i++) {
    const param = chosen.params[i];
    const { start, end } = argSpans[i];
    if (!param.name || start >= end || !inRange(start)) continue;
    if (chosen.source === 'builtin' && (param.name.length <= 1 || OBVIOUS_BUILTIN_NAMES.has(param.name))) continue;
    const text = model.text.slice(start, end);
    if (mode === 'literals' && !isLiteralLike(text)) continue;
    if (argNamesParam(text, param.name)) continue;
    out.push({
      position: model.lines.positionAt(start),
      label: `${param.name}:`,
      kind: InlayHintKind.Parameter,
      paddingRight: true,
      tooltip: param.doc ? { kind: MarkupKind.Markdown, value: param.doc } : undefined,
    });
  }
  return out;
}

/** Pure hint computation for a requested range (also used by tests). */
export function computeInlayHints(ctx: Pick<ServerContext, 'workspace'>, params: InlayHintParams, options: HintOptions = { mode: 'literals' }): InlayHint[] {
  if (options.mode === 'none') return [];
  const model = ctx.workspace.getModel(normalizeUri(params.textDocument.uri));
  if (!model) return [];
  const from = model.lines.offsetAt(params.range.start);
  const to = model.lines.offsetAt(params.range.end);
  const inRange = (o: number) => o >= from && o <= to;
  const out: InlayHint[] = [];
  for (const call of model.calls) {
    // Cheap rejection before any resolution: the call must overlap the range.
    const callStart = model.lines.offsetAt(call.range.start);
    const callEnd = call.closeParen !== undefined ? call.closeParen + 1 : model.lines.offsetAt(call.range.end);
    if (callEnd < from || callStart > to) continue;
    out.push(...hintForCall(ctx.workspace, model, call, options.mode, inRange));
  }
  return out;
}

export function register(ctx: ServerContext): void {
  // refresh() returns a promise: a client without refresh support rejects it.
  const refresh = onDependentsChanged(ctx, () => ctx.clientCapabilities.inlayHintRefresh, () => ctx.connection.languages.inlayHint.refresh(), 'inlayHint');
  ctx.settings.onDidChange((s, prev) => {
    if (s.inlayHints.parameterNames !== prev.inlayHints.parameterNames) refresh();
  });

  ctx.connection.languages.inlayHint.on((params) => {
    try {
      return computeInlayHints(ctx, params, { mode: ctx.settings.get().inlayHints.parameterNames });
    } catch (err) {
      ctx.log.error(`inlayHints failed: ${(err as Error).stack ?? err}`);
      return [];
    }
  });
}

