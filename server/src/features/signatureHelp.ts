// Signature help: the parameter popup while typing a call.
//
// Also home of the call -> signature candidate resolution that inlayHints.ts
// reuses (`resolveCallCandidates`). Everything except `register` is pure and
// takes a Workspace, so tests do not need a live connection.
//
// Flow: callAt(model, offset) finds the innermost call (unclosed ones too),
// the callee resolves to user/LYGIA functions, function-like macros, structs
// (constructor form), builtins, or a basic type (constructor forms are
// generated). Every overload becomes one SignatureInformation; the active one
// is picked by argument count, then by simple type matching of the arguments.

import {
  MarkupKind,
  type ParameterInformation,
  type SignatureHelp,
  type SignatureHelpParams,
  type SignatureInformation,
} from 'vscode-languageserver/node';
import type { BuiltinFunction } from '../builtins/types';
import type { ServerContext } from '../context';
import {
  activeArgument,
  callAt,
  definedInMarkdown,
  formatBuiltinOverload,
  formatDocMarkdown,
  formatFunction,
  formatParam,
  localsAt,
  lookupName,
  normalizeUri,
  paramDoc,
  swizzleType,
  symbolType,
  type CallSite,
  type FileModel,
  type FunctionSymbol,
  type MacroSymbol,
  type StructSymbol,
  type Workspace,
} from '../core';

// ---------------------------------------------------------------- candidates

export interface SigParam {
  name: string;
  /** Type as written (`vec2`, or a generic family like `genType` for builtins). */
  type: string;
  /** Text of this parameter inside the signature label. */
  label: string;
  /** Markdown documentation, if any. */
  doc?: string;
}

export interface SigCandidate {
  /** One-line signature shown in the popup. */
  label: string;
  params: SigParam[];
  /** Markdown shown below the signature. */
  documentation?: string;
  source: 'user' | 'macro' | 'struct' | 'builtin' | 'constructor';
  /** Return type (undefined for macros). */
  returnType?: string;
}

const MAX_CANDIDATES = 40;

function userFunctionCandidate(ws: Workspace, fn: FunctionSymbol): SigCandidate {
  const docMd = formatDocMarkdown(fn.doc);
  const parts = [docMd, definedInMarkdown(ws, fn)].filter(Boolean);
  return {
    label: formatFunction(fn),
    source: 'user',
    returnType: fn.returnType.name + (fn.returnType.array ?? ''),
    documentation: parts.join('\n\n'),
    params: fn.params.map((p) => {
      const d = p.doc ? formatDocMarkdown(p.doc) : paramDoc(fn.doc, p.name);
      return { name: p.name, type: p.type.name + (p.type.array ?? ''), label: formatParam(p), doc: d || undefined };
    }),
  };
}

function macroCandidate(ws: Workspace, m: MacroSymbol): SigCandidate {
  const docMd = formatDocMarkdown(m.doc);
  const body = m.body.length > 120 ? m.body.slice(0, 117) + '...' : m.body;
  const parts = [docMd, body ? '```glsl\n' + body + '\n```' : '', definedInMarkdown(ws, m)].filter(Boolean);
  const names = m.params ?? [];
  return {
    label: `${m.name}(${names.join(', ')})`,
    source: 'macro',
    documentation: parts.join('\n\n'),
    params: names.map((n) => ({ name: n, type: '', label: n, doc: paramDoc(m.doc, n) || undefined })),
  };
}

function structCandidate(ws: Workspace, s: StructSymbol): SigCandidate {
  const params = s.fields.map((f) => ({
    name: f.name,
    type: f.type.name + (f.type.array ?? ''),
    label: `${f.type.name} ${f.name}${f.type.array ?? ''}`,
    doc: f.doc ? formatDocMarkdown(f.doc) : undefined,
  }));
  const parts = [formatDocMarkdown(s.doc), definedInMarkdown(ws, s)].filter(Boolean);
  return {
    label: `${s.name}(${params.map((p) => p.label).join(', ')})`,
    source: 'struct',
    returnType: s.name,
    params,
    documentation: parts.join('\n\n'),
  };
}

function builtinCandidates(f: BuiltinFunction): SigCandidate[] {
  return f.overloads.map((o) => ({
    label: formatBuiltinOverload(f.name, o),
    source: 'builtin' as const,
    returnType: o.returnType,
    documentation: [f.doc, o.doc, f.docUrl ? `[Reference](${f.docUrl})` : ''].filter(Boolean).join('\n\n'),
    params: o.params.map((p) => ({
      name: p.name,
      type: p.type,
      label: `${p.qualifier && p.qualifier !== 'in' ? p.qualifier + ' ' : ''}${p.type} ${p.name}`,
      doc: p.doc,
    })),
  }));
}

const VECTOR_RE = /^([biud]?)vec([234])$/;
const MATRIX_RE = /^d?mat([234])(?:x([234]))?$/;
const COMPONENT: Record<string, string> = { '': 'float', b: 'bool', i: 'int', u: 'uint', d: 'double' };
const SCALARS = ['float', 'int', 'uint', 'bool'];

function ctor(name: string, params: { name: string; type: string }[], doc?: string): SigCandidate {
  const ps = params.map((p) => ({ ...p, label: `${p.type} ${p.name}` }));
  return { label: `${name}(${ps.map((p) => p.label).join(', ')})`, source: 'constructor', returnType: name, params: ps, documentation: doc };
}

/** Compositions of n into at least two parts (each >= 1), e.g. 3 -> [1,1,1] [1,2] [2,1]. */
function compositions(n: number): number[][] {
  const out: number[][] = [];
  const rec = (left: number, acc: number[]) => {
    if (left === 0) {
      if (acc.length >= 2) out.push(acc);
      return;
    }
    for (let k = 1; k <= left; k++) rec(left - k, [...acc, k]);
  };
  rec(n, []);
  return out.sort((a, b) => b.length - a.length || a.join().localeCompare(b.join()));
}

/** Constructor forms of a basic type. Empty when `name` is not constructible. */
export function constructorCandidates(ws: Workspace, name: string): SigCandidate[] {
  const doc = ws.builtins.types.get(name)?.doc;
  const vec = VECTOR_RE.exec(name);
  if (vec) {
    const n = Number(vec[2]);
    const comp = COMPONENT[vec[1]];
    const out = [ctor(name, [{ name: 's', type: comp }], doc)];
    for (const parts of compositions(n)) {
      let at = 0;
      out.push(
        ctor(
          name,
          parts.map((size) => {
            const label = 'xyzw'.slice(at, at + size);
            at += size;
            return { name: label, type: size === 1 ? comp : `${vec[1]}vec${size}` };
          }),
          doc,
        ),
      );
    }
    for (let m = n + 1; m <= 4; m++) out.push(ctor(name, [{ name: 'v', type: `${vec[1]}vec${m}` }], doc));
    return out;
  }
  const mat = MATRIX_RE.exec(name);
  if (mat) {
    const cols = Number(mat[1]);
    const rows = Number(mat[2] ?? mat[1]);
    const comp = name.startsWith('d') ? 'double' : 'float';
    const colType = `${comp === 'double' ? 'd' : ''}vec${rows}`;
    const out = [ctor(name, [{ name: 'diagonal', type: comp }], doc)];
    out.push(ctor(name, Array.from({ length: cols }, (_, i) => ({ name: `col${i}`, type: colType })), doc));
    const scalars: { name: string; type: string }[] = [];
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) scalars.push({ name: `m${c}${r}`, type: comp });
    out.push(ctor(name, scalars, doc));
    out.push(ctor(name, [{ name: 'm', type: `${name.startsWith('d') ? 'd' : ''}mat${cols === 2 ? 3 : 2}` }], doc));
    return out;
  }
  if (name === 'float' || name === 'int' || name === 'uint' || name === 'bool' || name === 'double') {
    return SCALARS.map((s) => ctor(name, [{ name: 'x', type: s }], doc));
  }
  return [];
}

/** All signature candidates for a call (every overload), possibly empty. */
export function resolveCallCandidates(ws: Workspace, model: FileModel, call: CallSite): SigCandidate[] {
  if (call.occurrence === undefined) return constructorCandidates(ws, call.name);
  const res = ws.resolveOccurrence(model, call.occurrence);
  if (!res) return call.isConstructor ? constructorCandidates(ws, call.name) : [];
  const out: SigCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: SigCandidate) => {
    if (seen.has(c.label) || out.length >= MAX_CANDIDATES) return;
    seen.add(c.label);
    out.push(c);
  };
  if (res.kind === 'symbol') {
    for (const s of res.symbols) {
      if (s.kind === 'function') push(userFunctionCandidate(ws, s));
      else if (s.kind === 'macro' && s.params && !s.isIncludeGuard) push(macroCandidate(ws, s));
      else if (s.kind === 'struct') push(structCandidate(ws, s));
    }
  } else if (res.kind === 'builtin') {
    if (res.entry.kind === 'function') builtinCandidates(res.entry).forEach(push);
    else if (res.entry.kind === 'type') constructorCandidates(ws, res.name).forEach(push);
  }
  return out;
}

// ---------------------------------------------------------------- argument types

const NUMBER_RE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?(?:[fF]|lf|LF)?$/;
const INT_RE = /^[+-]?(?:0[xX][0-9a-fA-F]+|\d+)$/;
const UINT_RE = /^[+-]?(?:0[xX][0-9a-fA-F]+|\d+)[uU]$/;
const IDENT_RE = /^[A-Za-z_]\w*$/;
const SWIZZLE_ACCESS_RE = /^([A-Za-z_]\w*)\.([xyzwrgbastpq]{1,4})$/;

/** Best-effort type of an argument expression; undefined when unknown. */
export function inferArgType(ws: Workspace, model: FileModel, arg: { start: number; end: number }): string | undefined {
  let text = model.text.slice(arg.start, arg.end).trim();
  if (!text) return undefined;
  if (text === 'true' || text === 'false') return 'bool';
  if (UINT_RE.test(text)) return 'uint';
  if (INT_RE.test(text)) return 'int';
  if (NUMBER_RE.test(text)) return 'float';
  if (text.startsWith('-') || text.startsWith('+')) text = text.slice(1).trim();
  const identType = (name: string): string | undefined => {
    const local = localsAt(model, arg.start).find((s) => s.name === name);
    if (local) return symbolType(local)?.name;
    const found = lookupName(ws, model, name, arg.start).symbols[0];
    if (found) return symbolType(found)?.name;
    const entry = ws.builtins.get(name, ws.builtinFilter(model));
    return entry?.kind === 'variable' ? entry.type : undefined;
  };
  if (IDENT_RE.test(text)) return identType(text);
  const sw = SWIZZLE_ACCESS_RE.exec(text);
  if (sw) {
    const base = identType(sw[1]);
    return base ? swizzleType(base, sw[2]) : undefined;
  }
  // A whole call expression `name(...)`.
  const call = model.calls.find((c) => model.lines.offsetAt(c.nameRange.start) === arg.start && c.closeParen !== undefined && c.closeParen + 1 === arg.end);
  if (call) {
    if (call.isConstructor) return call.name;
    const first = resolveCallCandidates(ws, model, call).find((c) => c.params.length === call.args.length && c.returnType);
    if (first?.returnType && !first.returnType.startsWith('gen')) return first.returnType;
  }
  return undefined;
}

const GENERIC: Record<string, RegExp> = {
  genType: /^(float|vec[234])$/,
  genIType: /^(int|ivec[234])$/,
  genUType: /^(uint|uvec[234])$/,
  genBType: /^(bool|bvec[234])$/,
  genDType: /^(double|dvec[234])$/,
  vec: /^vec[234]$/,
  ivec: /^ivec[234]$/,
  uvec: /^uvec[234]$/,
  bvec: /^bvec[234]$/,
  mat: /^mat[234](x[234])?$/,
};

const IMPLICIT: Record<string, string[]> = {
  int: ['uint', 'float', 'double'],
  uint: ['float', 'double'],
  float: ['double'],
  ivec2: ['uvec2', 'vec2', 'dvec2'],
  ivec3: ['uvec3', 'vec3', 'dvec3'],
  ivec4: ['uvec4', 'vec4', 'dvec4'],
  uvec2: ['vec2', 'dvec2'],
  uvec3: ['vec3', 'dvec3'],
  uvec4: ['vec4', 'dvec4'],
  vec2: ['dvec2'],
  vec3: ['dvec3'],
  vec4: ['dvec4'],
};

/** `[g|i|u]sampler<suffix>` / `image<suffix>`: prefix, kind, suffix. */
const SAMPLER_RE = /^([giu]?)(sampler|image)(\w*)$/;

/** 2 exact, 1 compatible (generic family / implicit conversion), 0 unknown, -3 mismatch. */
export function typeScore(paramType: string, argType: string | undefined): number {
  if (!argType || !paramType) return 0;
  const p = paramType.replace(/\[.*$/, '');
  const a = argType.replace(/\[.*$/, '');
  if (p === a) return 2;
  const generic = GENERIC[p];
  if (generic) return generic.test(a) ? 1 : -3;
  const ps = SAMPLER_RE.exec(p);
  if (ps) {
    // Same dimension/kind suffix (2D, Cube, 2DArray, 2DShadow...) and a compatible prefix.
    const as = SAMPLER_RE.exec(a);
    if (!as || as[2] !== ps[2]) return -3;
    const prefixOk = ps[1] === 'g' || ps[1] === as[1];
    return prefixOk && as[3] === ps[3] ? 2 : -3;
  }
  if (IMPLICIT[a]?.includes(p)) return 1;
  return -3;
}

// ---------------------------------------------------------------- selection

/** Score of a candidate for a call being typed; higher is better, -Infinity is unusable. */
export function scoreCandidate(c: SigCandidate, args: (string | undefined)[], needed: number, argCount: number): number {
  const n = c.params.length;
  let score = 0;
  if (n === argCount && argCount >= needed) score += 100;
  else if (n >= needed) score += 50 - (c.source === 'constructor' ? 0 : Math.min(n - needed, 40)); // still typing: has room for the active parameter
  else score -= 100 + (needed - n);
  for (let i = 0; i < Math.min(n, args.length); i++) score += typeScore(c.params[i].type, args[i]);
  return score;
}

/** Index of the best candidate, or `previous` if it is still just as good. */
export function pickActiveCandidate(
  candidates: SigCandidate[],
  args: (string | undefined)[],
  activeParam: number,
  argCount: number,
  previous?: number,
): number {
  const needed = Math.max(argCount, activeParam + 1);
  const scores = candidates.map((c) => scoreCandidate(c, args, needed, argCount));
  let best = 0;
  scores.forEach((s, i) => {
    if (s > scores[best]) best = i;
  });
  if (previous !== undefined && previous >= 0 && previous < scores.length && scores[previous] >= scores[best]) return previous;
  return best;
}

// ---------------------------------------------------------------- LSP conversion

function toSignatureInformation(c: SigCandidate): SignatureInformation {
  // Parameter labels as [start, end] offsets into the signature label.
  let cursor = c.label.indexOf('(') + 1;
  const parameters: ParameterInformation[] = c.params.map((p) => {
    const start = c.label.indexOf(p.label, cursor);
    if (start < 0) return { label: p.label, documentation: p.doc ? { kind: MarkupKind.Markdown, value: p.doc } : undefined };
    cursor = start + p.label.length;
    return {
      label: [start, cursor] as [number, number],
      documentation: p.doc ? { kind: MarkupKind.Markdown, value: p.doc } : undefined,
    };
  });
  return {
    label: c.label,
    documentation: c.documentation ? { kind: MarkupKind.Markdown, value: c.documentation } : undefined,
    parameters,
  };
}

/** Pure signature-help computation (also used by tests). */
export function computeSignatureHelp(ctx: Pick<ServerContext, 'workspace'>, params: SignatureHelpParams): SignatureHelp | null {
  const ws = ctx.workspace;
  const uri = normalizeUri(params.textDocument.uri);
  const model = ws.getModel(uri);
  if (!model) return null;
  const offset = model.lines.offsetAt(params.position);
  const call = callAt(model, offset);
  if (!call) return null;
  const candidates = resolveCallCandidates(ws, model, call);
  if (!candidates.length) return null;

  const activeParam = activeArgument(call, offset);
  const args = call.args.map((r) => inferArgType(ws, model, { start: model.lines.offsetAt(r.start), end: model.lines.offsetAt(r.end) }));
  const argCount = call.args.length;

  // Keep the signature the editor already shows while it is still as good (typing a comma).
  const prev = params.context?.activeSignatureHelp;
  const sameSet = prev && prev.signatures.length === candidates.length && prev.signatures.every((s, i) => s.label === candidates[i].label);
  const active = pickActiveCandidate(candidates, args, activeParam, argCount, sameSet ? prev.activeSignature : undefined);

  const chosen = candidates[active];
  return {
    signatures: candidates.map(toSignatureInformation),
    activeSignature: active,
    // Beyond the last parameter nothing is highlighted.
    activeParameter: activeParam < chosen.params.length ? activeParam : undefined,
  };
}

export function register(ctx: ServerContext): void {
  ctx.connection.onSignatureHelp((params) => {
    try {
      return computeSignatureHelp(ctx, params);
    } catch (err) {
      ctx.log.error(`signatureHelp failed: ${(err as Error).stack ?? err}`);
      return null;
    }
  });
}
