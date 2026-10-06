// Symbol resolution: what does the identifier at a position refer to?
//
// Lookup order for a name used in file F at offset o:
//   1. locals/params of the scopes enclosing o (declared before o)
//   2. top-level symbols of F
//   3. top-level symbols of F's transitive includes (include order)
//   4. builtins (respecting the shadertoy setting)
//   5. fallback: any indexed file declaring the name (`fromWorkspace: true`),
//      preferring files visible from the files that include F. This makes
//      library files that rely on their includer's includes still navigable.
// Members (`a.b`) resolve through the receiver's type to a struct/block field;
// vector members are reported as swizzles.

import type { BuiltinEntry } from '../builtins';
import { BASIC_TYPES, isKeyword, SWIZZLE_RE } from './keywords';
import { tokenIndexAt } from './lexer';
import type {
  BlockSymbol,
  CallSite,
  FieldSymbol,
  FileModel,
  FunctionSymbol,
  GlobalSymbol,
  GlslSymbol,
  IncludeDirective,
  Occurrence,
  ParameterSymbol,
  Scope,
  StructSymbol,
  TypeRef,
  VariableSymbol,
} from './model';
import { rangeContains, type Position, type Range } from './text';
import type { Workspace } from './workspace';

export type LocalSymbol = VariableSymbol | ParameterSymbol | StructSymbol;

export interface VisibleSymbols {
  /** Locals and parameters in scope, innermost first, shadowed names removed. */
  locals: LocalSymbol[];
  /** Top-level symbols of the file and its transitive includes (file first, then include order). */
  globals: GlobalSymbol[];
  /** Fields of instance-less interface blocks (usable as bare names). */
  blockFields: FieldSymbol[];
  /** The file itself followed by its transitive includes. */
  files: string[];
}

export type Resolution =
  | {
      kind: 'symbol';
      name: string;
      /** All candidates: every overload for functions, else usually one symbol. */
      symbols: GlslSymbol[];
      /** The best candidate: the declaration itself, or the overload matching the call's argument count. */
      primary: GlslSymbol;
      occurrence?: Occurrence;
      call?: CallSite;
      /** Found only through the workspace-wide fallback (not visible through includes). */
      fromWorkspace?: boolean;
    }
  | { kind: 'builtin'; name: string; entry: BuiltinEntry; occurrence?: Occurrence; call?: CallSite }
  | { kind: 'include'; include: IncludeDirective; targetUri?: string }
  | { kind: 'swizzle'; name: string; occurrence: Occurrence; receiverType?: string; resultType?: string };

export interface ReferenceLocation {
  uri: string;
  range: Range;
  isDeclaration: boolean;
}

// ---------------------------------------------------------------- scopes

/** Innermost scope containing `offset`. */
export function scopeAt(model: FileModel, offset: number): Scope {
  let scope = model.rootScope;
  for (;;) {
    const child = scope.children.find((c) => c.start <= offset && offset <= c.end);
    if (!child) return scope;
    scope = child;
  }
}

/** Locals visible at `offset` (declared before it), innermost first, deduplicated by name. */
export function localsAt(model: FileModel, offset: number): LocalSymbol[] {
  const out: LocalSymbol[] = [];
  const seen = new Set<string>();
  for (let s: Scope | undefined = scopeAt(model, offset); s; s = s.parent) {
    for (let i = s.symbols.length - 1; i >= 0; i--) {
      const sym = s.symbols[i];
      if (sym.kind !== 'parameter' && (sym.kind === 'variable' ? sym.visibleFrom ?? sym.nameOffset : sym.nameOffset) > offset) continue;
      if (seen.has(sym.name)) continue;
      seen.add(sym.name);
      out.push(sym);
    }
  }
  return out;
}

/** The function whose body/params contain `offset`. */
export function enclosingFunction(model: FileModel, offset: number): FunctionSymbol | undefined {
  for (let s: Scope | undefined = scopeAt(model, offset); s; s = s.parent) if (s.function) return s.function;
  return undefined;
}

export function visibleSymbols(ws: Workspace, uri: string, position: Position): VisibleSymbols {
  const model = ws.getModel(uri);
  if (!model) return { locals: [], globals: [], blockFields: [], files: [] };
  const offset = model.lines.offsetAt(position);
  const files = [uri, ...ws.transitiveIncludes(uri)];
  const globals: GlobalSymbol[] = [];
  const blockFields: FieldSymbol[] = [];
  for (const f of files) {
    const m = ws.getModel(f);
    if (!m) continue;
    globals.push(...m.symbols);
    for (const b of m.blocks) if (!b.instanceName) blockFields.push(...b.fields);
  }
  return { locals: localsAt(model, offset), globals, blockFields, files };
}

// ---------------------------------------------------------------- occurrences

/** Index of the occurrence covering `offset` (end inclusive), or -1. */
export function occurrenceIndexAt(model: FileModel, offset: number): number {
  const occ = model.occurrences;
  let lo = 0;
  let hi = occ.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < occ[mid].start) hi = mid - 1;
    else if (offset > occ[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** The innermost call whose parentheses contain `offset` (for signature help). */
export function callAt(model: FileModel, offset: number): CallSite | undefined {
  let best: CallSite | undefined;
  for (const c of model.calls) {
    if (offset <= c.openParen) continue;
    if (c.closeParen !== undefined) {
      if (offset > c.closeParen) continue;
    } else if (hasStatementBoundary(model, c.openParen + 1, offset)) {
      // An unclosed call reaches the cursor only if no statement boundary sits in between.
      continue;
    }
    if (!best || c.openParen > best.openParen) best = c;
  }
  return best;
}

/** True when a `;`, `{` or `}` token (not inside a comment or directive) lies in [start, end). */
function hasStatementBoundary(model: FileModel, start: number, end: number): boolean {
  if (!/[;{}]/.test(model.text.slice(start, end))) return false;
  for (let i = Math.max(0, tokenIndexAt(model.tokens, start) - 1); i < model.tokens.length; i++) {
    const t = model.tokens[i];
    if (t.start >= end) break;
    if (t.end <= start) continue;
    if (t.kind === 'lineComment' || t.kind === 'blockComment' || t.kind === 'directive') continue;
    if (t.text === ';' || t.text === '{' || t.text === '}') return true;
  }
  return false;
}

/** Index of the argument containing `offset` in `call` (0-based, by commas). */
export function activeArgument(call: CallSite, offset: number): number {
  let i = 0;
  for (const c of call.commas) if (offset > c) i++;
  return i;
}

// ---------------------------------------------------------------- name lookup

interface Lookup {
  symbols: GlslSymbol[];
  fromWorkspace?: boolean;
}

type RoleFilter = 'any' | 'type' | 'directive';

function acceptKind(s: GlslSymbol, filter: RoleFilter): boolean {
  if (filter === 'type') return s.kind === 'struct' || s.kind === 'block' || s.kind === 'macro';
  if (filter === 'directive') return s.kind === 'macro' || s.kind === 'function' || s.kind === 'variable' || s.kind === 'struct';
  return true;
}

/** Looks a name up from `offset` in `model`, following the documented order (builtins excluded). */
export function lookupName(ws: Workspace, model: FileModel, name: string, offset: number, filter: RoleFilter = 'any'): Lookup {
  if (filter !== 'directive') {
    const local = localsAt(model, offset).find((s) => s.name === name && acceptKind(s, filter));
    if (local) return { symbols: [local] };
  }
  const found: GlslSymbol[] = [];
  const files = [model.uri, ...ws.transitiveIncludes(model.uri)];
  for (const f of files) {
    const m = ws.getModel(f);
    if (!m) continue;
    for (const s of m.symbols) if (s.name === name && acceptKind(s, filter)) found.push(s);
    for (const b of m.blocks) if (!b.instanceName) for (const fl of b.fields) if (fl.name === name) found.push(fl);
  }
  if (found.length) return { symbols: preferDefinitions(found) };
  return { symbols: [] };
}

/** Workspace-wide fallback: candidates from the first best file. */
function workspaceFallback(ws: Workspace, model: FileModel, name: string, filter: RoleFilter): Lookup {
  const all = ws.lookupGlobal(name).filter((s) => acceptKind(s, filter) && !(s.kind === 'macro' && s.isIncludeGuard));
  if (!all.length) return { symbols: [] };
  // Prefer files visible from any file that includes this one.
  const context = new Set<string>();
  for (const inc of ws.transitiveIncluders(model.uri)) {
    context.add(inc);
    for (const u of ws.transitiveIncludes(inc)) context.add(u);
  }
  const preferred = all.find((s) => context.has(s.uri)) ?? all[0];
  return { symbols: preferDefinitions(all.filter((s) => s.uri === preferred.uri)), fromWorkspace: true };
}

/** Puts function definitions before prototypes of the same signature, keeps order otherwise. */
function preferDefinitions(symbols: GlslSymbol[]): GlslSymbol[] {
  const defs = symbols.filter((s) => !(s.kind === 'function' && s.isPrototype));
  const protos = symbols.filter((s) => s.kind === 'function' && s.isPrototype);
  const out = [...defs];
  for (const p of protos as FunctionSymbol[]) {
    const sig = signatureKey(p);
    if (!defs.some((d) => d.kind === 'function' && signatureKey(d) === sig)) out.push(p);
  }
  return out;
}

function signatureKey(f: FunctionSymbol): string {
  return f.name + '(' + f.params.map((p) => p.type.name + (p.type.array ?? '')).join(',') + ')';
}

/** Picks the overload whose parameter count matches the call. */
export function pickOverload(symbols: GlslSymbol[], call?: CallSite): GlslSymbol {
  if (call) {
    const n = call.args.length;
    const match = symbols.find((s) => s.kind === 'function' && s.params.length === n);
    if (match) return match;
  }
  return symbols[0];
}

// ---------------------------------------------------------------- types

const VECTOR_RE = /^([biud]?)vec([234])$/;
const COMPONENT_TYPE: Record<string, string> = { '': 'float', b: 'bool', i: 'int', u: 'uint', d: 'double' };

/** Type of a swizzle applied to a vector type, e.g. vec3 + 'xy' -> vec2. */
export function swizzleType(vectorType: string, swizzle: string): string | undefined {
  const m = VECTOR_RE.exec(vectorType);
  if (!m || !SWIZZLE_RE.test(swizzle)) return undefined;
  if (swizzle.length === 1) return COMPONENT_TYPE[m[1]];
  return `${m[1]}vec${swizzle.length}`;
}

/** Struct or interface block named `name` visible from `model` (falls back to the workspace). */
export function findStructType(ws: Workspace, model: FileModel, name: string, offset = 0): StructSymbol | BlockSymbol | undefined {
  const local = localsAt(model, offset).find((s): s is StructSymbol => s.kind === 'struct' && s.name === name);
  if (local) return local;
  const res = lookupName(ws, model, name, offset, 'type');
  const hit = res.symbols.find((s): s is StructSymbol | BlockSymbol => s.kind === 'struct' || s.kind === 'block');
  if (hit) return hit;
  return ws.lookupGlobal(name).find((s): s is StructSymbol | BlockSymbol => s.kind === 'struct' || s.kind === 'block');
}

/** Static type of the symbol when used as a value. */
export function symbolType(sym: GlslSymbol): TypeRef | undefined {
  switch (sym.kind) {
    case 'variable':
    case 'parameter':
    case 'field':
      return sym.type;
    case 'function':
      return sym.returnType;
    case 'struct':
      return { name: sym.name };
    default:
      return undefined;
  }
}

const MATRIX_RE = /^(d?)mat([234])(?:x([234]))?$/;

/** Type after `[i]`: array element, vector component or matrix column. */
export function indexedType(t: TypeRef): TypeRef | undefined {
  if (t.array) {
    const rest = t.array.replace(/^\[[^\]]*\]/, '');
    return rest ? { name: t.name, array: rest } : { name: t.name };
  }
  const v = VECTOR_RE.exec(t.name);
  if (v) return { name: COMPONENT_TYPE[v[1]] };
  const m = MATRIX_RE.exec(t.name);
  if (m) return { name: `${m[1]}vec${m[3] ?? m[2]}` };
  return undefined;
}

/**
 * Static type of the expression that ends at `end` (exclusive): an
 * identifier, member, call, constructor, `[i]` subscript or a parenthesized
 * identifier. Used for `m[0].x`, `vec3(1.0).y`, `texture(t, uv).rgb`.
 */
export function typeOfExpressionEndingAt(ws: Workspace, model: FileModel, end: number, depth = 0): TypeRef | undefined {
  if (depth > 16 || end <= 0) return undefined;
  const text = model.text;
  while (end > 0 && /\s/.test(text.charAt(end - 1))) end--;
  const last = text.charAt(end - 1);
  if (/\w/.test(last)) {
    const idx = occurrenceIndexAt(model, end - 1);
    const occ = model.occurrences[idx];
    if (idx < 0 || !occ || occ.end !== end) return undefined;
    return typeOfOccurrence(ws, model, idx, depth + 1);
  }
  if (last === ']') {
    const pair = model.brackets.find((b) => b.char === '[' && b.close === end - 1);
    if (!pair) return undefined;
    const base = typeOfExpressionEndingAt(ws, model, pair.open, depth + 1);
    return base ? indexedType(base) : undefined;
  }
  if (last === ')') {
    const close = end - 1;
    const call = model.calls.find((c) => c.closeParen === close);
    if (call) {
      if (call.isConstructor) {
        // `vec3(...)`, or an array constructor `float[2](...)`.
        const between = text.slice(model.lines.offsetAt(call.nameRange.end), call.openParen);
        const arr = /\[[^\]]*\]/.exec(between);
        return arr ? { name: call.name, array: arr[0].replace(/\s+/g, '') } : { name: call.name };
      }
      if (call.occurrence !== undefined) return typeOfOccurrence(ws, model, call.occurrence, depth + 1);
      return undefined;
    }
    const pair = model.brackets.find((b) => b.char === '(' && b.close === close);
    if (!pair) return undefined;
    const inner = text.slice(pair.open + 1, close).trim();
    if (/^[\w.[\]]+$/.test(inner)) return typeOfExpressionEndingAt(ws, model, text.lastIndexOf(inner, close) + inner.length, depth + 1);
    return undefined;
  }
  return undefined;
}

const LITERAL_FLOAT_RE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+(?=[eE]))(?:[eE][+-]?\d+)?[fF]?$/;
const LITERAL_INT_RE = /^[+-]?(?:0[xX][0-9a-fA-F]+|\d+)$/;
const LITERAL_UINT_RE = /^[+-]?(?:0[xX][0-9a-fA-F]+|\d+)[uU]$/;

function vectorSize(type: string): number {
  if (/^(float|int|uint|bool|double)$/.test(type)) return 1;
  const m = VECTOR_RE.exec(type);
  return m ? Number(m[2]) : 0;
}

/** Best-effort type name of a call argument (literals, operands, calls). */
export function typeOfArgument(ws: Workspace, model: FileModel, arg: { start: number; end: number }, depth = 0): string | undefined {
  const text = model.text.slice(arg.start, arg.end).trim();
  if (!text) return undefined;
  if (text === 'true' || text === 'false') return 'bool';
  if (LITERAL_UINT_RE.test(text)) return 'uint';
  if (LITERAL_INT_RE.test(text)) return 'int';
  if (LITERAL_FLOAT_RE.test(text)) return 'float';
  const tail = typeOfExpressionEndingAt(ws, model, arg.end, depth + 1);
  if (tail && !tail.array && !/[-+*/%?<>=!&|^]/.test(text.replace(/^[-+]/, ''))) return tail.name;
  // An operator expression: the widest vector operand wins (`uv * 2.0` -> vec2).
  let best = tail && !tail.array ? tail.name : undefined;
  const occ = model.occurrences;
  for (let i = 0; i < occ.length; i++) {
    const o = occ[i];
    if (o.start < arg.start) continue;
    if (o.end > arg.end) break;
    if (o.role !== 'reference' && o.role !== 'call') continue;
    const c = o.role === 'call' && o.call !== undefined ? model.calls[o.call] : undefined;
    const exprEnd = c?.closeParen !== undefined ? c.closeParen + 1 : o.end;
    const nextCh = model.text.slice(exprEnd, exprEnd + 64).trimStart().charAt(0);
    if (nextCh === '.' || nextCh === '[') continue;
    const ty = typeOfExpressionEndingAt(ws, model, exprEnd, depth + 1);
    if (!ty || ty.array) continue;
    if (!best || vectorSize(ty.name) > vectorSize(best)) best = ty.name;
  }
  if (!best) {
    for (const c of model.calls) {
      if (!c.isConstructor || c.closeParen === undefined) continue;
      const s = model.lines.offsetAt(c.nameRange.start);
      if (s < arg.start || c.closeParen >= arg.end) continue;
      if (!best || vectorSize(c.name) > vectorSize(best)) best = c.name;
    }
  }
  if (!best && /\d\.|\.\d/.test(text)) best = 'float';
  return best;
}

const GEN_FAMILY: Record<string, string> = {
  genType: '',
  genIType: 'i',
  genUType: 'u',
  genBType: 'b',
  genDType: 'd',
  vec: '',
  ivec: 'i',
  uvec: 'u',
  bvec: 'b',
  dvec: 'd',
};
const GEN_SCALAR: Record<string, boolean> = { genType: true, genIType: true, genUType: true, genBType: true, genDType: true };

/**
 * Concrete return type of a builtin overload whose return type is generic
 * (`genType`, `bvec`, `gvec4`, `mat`), from the argument types of `call`.
 * Concrete return types are returned as is; undefined when unknown.
 */
export function concreteBuiltinReturn(
  ws: Workspace,
  model: FileModel,
  overload: { returnType: string; params: { type: string }[] },
  call: CallSite | undefined,
  depth = 0,
): string | undefined {
  const rt = overload.returnType;
  const argType = (i: number): string | undefined => {
    const r = call?.args[i];
    return r ? typeOfArgument(ws, model, { start: model.lines.offsetAt(r.start), end: model.lines.offsetAt(r.end) }, depth + 1) : undefined;
  };
  const gv = /^gvec([234])$/.exec(rt);
  if (gv) {
    const sampler = argType(0) ?? '';
    const prefix = /^isampler|^iimage/.test(sampler) ? 'i' : /^usampler|^uimage/.test(sampler) ? 'u' : '';
    return `${prefix}vec${gv[1]}`;
  }
  if (rt === 'mat') {
    const i = overload.params.findIndex((p) => p.type === 'mat');
    const t = i >= 0 ? argType(i) : undefined;
    return t && MATRIX_RE.test(t) ? t : undefined;
  }
  const prefix = GEN_FAMILY[rt];
  if (prefix === undefined) return rt;
  // Size from the first argument whose parameter is generic.
  for (let i = 0; i < overload.params.length; i++) {
    if (GEN_FAMILY[overload.params[i].type] === undefined) continue;
    const t = argType(i);
    if (!t) continue;
    const n = vectorSize(t);
    if (!n) continue;
    if (n === 1) return GEN_SCALAR[rt] ? COMPONENT_TYPE[prefix] : undefined;
    return `${prefix}vec${n}`;
  }
  return undefined;
}

const SAMPLER_RE = /^[iu]?(sampler|image)/;

/** How well an argument of type `arg` fits a builtin parameter of type `param`: -1 = cannot, 0 = unknown, higher = better. */
function paramFit(param: string, arg: string | undefined): number {
  if (!arg) return 0;
  if (param === arg) return 3;
  const g = /^g((?:sampler|image).*)$/.exec(param);
  if (g) return arg.replace(/^[iu]/, '') === g[1] ? 3 : SAMPLER_RE.test(arg) ? -1 : 0;
  if (SAMPLER_RE.test(param) || SAMPLER_RE.test(arg)) return -1;
  const prefix = GEN_FAMILY[param];
  if (prefix !== undefined) {
    const n = vectorSize(arg);
    if (!n) return 0;
    const fam = n === 1 ? arg === COMPONENT_TYPE[prefix] : arg.startsWith(`${prefix}vec`);
    return fam ? 2 : 0;
  }
  return 0;
}

/**
 * The builtin overload a call most likely refers to: same number of arguments,
 * then the best fit of the argument types that are known (sampler flavours
 * decide e.g. `textureSize`). Falls back to the first overload.
 */
export function pickBuiltinOverload<O extends { returnType: string; params: { type: string }[] }>(
  ws: Workspace,
  model: FileModel,
  overloads: readonly O[],
  call: CallSite | undefined,
  depth = 0,
): O {
  const n = call?.args.length;
  const sameArity = overloads.filter((ov) => ov.params.length === n);
  if (sameArity.length <= 1 || !call) return sameArity[0] ?? overloads[0];
  const types = call.args.map((r) => typeOfArgument(ws, model, { start: model.lines.offsetAt(r.start), end: model.lines.offsetAt(r.end) }, depth + 1));
  let best = sameArity[0];
  let bestScore = -Infinity;
  for (const ov of sameArity) {
    let score = 0;
    for (let i = 0; i < ov.params.length && score > -Infinity; i++) {
      const f = paramFit(ov.params[i].type, types[i]);
      score = f < 0 ? -Infinity : score + f;
    }
    if (score > bestScore) {
      best = ov;
      bestScore = score;
    }
  }
  return best;
}

/** Receiver type of member occurrence `occ`: the expression before its `.`. */
function memberReceiverType(ws: Workspace, model: FileModel, occ: Occurrence, depth: number): TypeRef | undefined {
  const text = model.text;
  let p = occ.start;
  while (p > 0 && /\s/.test(text.charAt(p - 1))) p--;
  if (text.charAt(p - 1) === '.') {
    const t = typeOfExpressionEndingAt(ws, model, p - 1, depth + 1);
    if (t) return t;
  }
  if (occ.receiver !== undefined) return typeOfOccurrence(ws, model, occ.receiver, depth + 1);
  return undefined;
}

/** Best-effort static type of occurrence `index` (variables, fields, calls, swizzles). */
export function typeOfOccurrence(ws: Workspace, model: FileModel, index: number, depth = 0): TypeRef | undefined {
  if (depth > 16) return undefined;
  const occ = model.occurrences[index];
  if (!occ) return undefined;
  if (occ.role === 'member') {
    const recv = memberReceiverType(ws, model, occ, depth);
    if (!recv) return undefined;
    if (occ.name === 'length' && occ.call !== undefined) return { name: 'int' };
    const sw = swizzleType(recv.name, occ.name);
    if (sw) return { name: sw };
    const st = findStructType(ws, model, recv.name, occ.start);
    const field = st?.fields.find((f) => f.name === occ.name);
    return field?.type;
  }
  const res = resolveOccurrence(ws, model, index, depth + 1);
  if (!res) return undefined;
  if (res.kind === 'symbol') return symbolType(res.primary);
  if (res.kind === 'builtin') {
    const e = res.entry;
    if (e.kind === 'variable') return { name: e.type };
    if (e.kind === 'function' && e.overloads.length) {
      const o = pickBuiltinOverload(ws, model, e.overloads, res.call, depth + 1);
      const name = concreteBuiltinReturn(ws, model, o, res.call, depth + 1);
      return name ? { name } : undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- resolution

export function resolveSymbolAt(ws: Workspace, uri: string, position: Position): Resolution | undefined {
  const model = ws.getModel(uri);
  if (!model) return undefined;
  for (const inc of model.includes) {
    if (rangeContains(inc.pathRange, position)) return { kind: 'include', include: inc, targetUri: inc.resolvedUri };
  }
  const offset = model.lines.offsetAt(position);
  const idx = occurrenceIndexAt(model, offset);
  if (idx >= 0) return resolveOccurrence(ws, model, idx);

  // Keywords and builtin type names are not recorded as occurrences.
  const ti = tokenIndexAt(model.tokens, offset);
  const tok = model.tokens[ti];
  if (tok && tok.kind === 'ident' && (isKeyword(tok.text) || BASIC_TYPES.has(tok.text))) {
    const entry = ws.builtins.get(tok.text);
    if (entry) return { kind: 'builtin', name: tok.text, entry };
  }
  return undefined;
}

export function resolveOccurrence(ws: Workspace, model: FileModel, index: number, depth = 0): Resolution | undefined {
  const occ = model.occurrences[index];
  if (!occ) return undefined;
  const call = occ.call !== undefined ? model.calls[occ.call] : undefined;

  if (occ.role === 'declaration' && occ.symbol) {
    const sym = occ.symbol;
    let symbols: GlslSymbol[] = [sym];
    if (sym.kind === 'function') {
      const all = lookupName(ws, model, sym.name, occ.start).symbols.filter((s) => s.kind === 'function');
      symbols = [sym, ...all.filter((s) => s !== sym)];
    }
    return { kind: 'symbol', name: occ.name, symbols, primary: sym, occurrence: occ };
  }

  if (occ.role === 'member') {
    const recv = memberReceiverType(ws, model, occ, depth);
    if (!recv) return undefined;
    const sw = swizzleType(recv.name, occ.name);
    if (sw) return { kind: 'swizzle', name: occ.name, occurrence: occ, receiverType: recv.name, resultType: sw };
    const st = findStructType(ws, model, recv.name, occ.start);
    const field = st?.fields.find((f) => f.name === occ.name);
    if (field) return { kind: 'symbol', name: occ.name, symbols: [field], primary: field, occurrence: occ, call };
    if (occ.name === 'length' && call) {
      const entry = ws.builtins.get('length');
      if (entry) return { kind: 'builtin', name: 'length', entry, occurrence: occ, call };
    }
    return undefined;
  }

  const filter: RoleFilter = occ.role === 'type' ? 'type' : occ.role === 'directive' ? 'directive' : 'any';
  const found = lookupName(ws, model, occ.name, occ.start, filter);
  if (found.symbols.length) {
    return { kind: 'symbol', name: occ.name, symbols: found.symbols, primary: pickOverload(found.symbols, call), occurrence: occ, call };
  }
  const entry = ws.builtins.get(occ.name, ws.builtinFilter());
  if (entry) return { kind: 'builtin', name: occ.name, entry, occurrence: occ, call };
  const fb = workspaceFallback(ws, model, occ.name, filter);
  if (fb.symbols.length) {
    return { kind: 'symbol', name: occ.name, symbols: fb.symbols, primary: pickOverload(fb.symbols, call), occurrence: occ, call, fromWorkspace: true };
  }
  return undefined;
}

// ---------------------------------------------------------------- references

/**
 * Identity of a symbol for reference matching. Overloads of a function in
 * one file share an identity (renaming one renames the call sites of all).
 */
export function symbolKey(s: GlslSymbol): string {
  switch (s.kind) {
    case 'function':
      return `${s.uri}|fn|${s.name}`;
    case 'field':
      return `${s.uri}|field|${s.parentKey ?? s.parent}|${s.name}`;
    case 'struct':
      return s.local ? `${s.uri}|lstruct|${s.nameOffset}` : `${s.uri}|struct|${s.name}`;
    case 'parameter':
      return `${s.uri}|param|${s.nameOffset}`;
    case 'variable':
      return s.storage === 'local' ? `${s.uri}|local|${s.nameOffset}` : `${s.uri}|var|${s.name}`;
    default:
      return `${s.uri}|${s.kind}|${s.name}`;
  }
}

/** True for parameters, local variables and structs declared inside a function. */
export function isLocalSymbol(ws: Workspace, s: GlslSymbol): boolean {
  if (s.kind === 'parameter') return true;
  if (s.kind === 'variable') return s.storage === 'local';
  if (s.kind === 'struct') return !!s.local || !ws.getModel(s.uri)?.structs.includes(s);
  return false;
}

/** A field of an interface block without instance name: usable as a bare global name. */
function isBareBlockField(ws: Workspace, f: FieldSymbol): boolean {
  return !!ws.getModel(f.uri)?.blocks.some((b) => !b.instanceName && b.fields.includes(f));
}

export function findReferences(ws: Workspace, uri: string, position: Position, includeDeclaration: boolean): ReferenceLocation[] {
  const res = resolveSymbolAt(ws, uri, position);
  if (!res || res.kind !== 'symbol') return [];
  const keys = new Set(res.symbols.map(symbolKey));
  const name = res.name;
  const primary = res.primary;
  const models: FileModel[] = [];
  if (isLocalSymbol(ws, primary)) {
    const m = ws.getModel(primary.uri);
    if (m) models.push(m);
  } else {
    for (const m of ws.allModels()) if (m.text.includes(name)) models.push(m);
  }
  const isField = primary.kind === 'field';
  // Fields of an instance-less block are also used as bare names (`gain * 2.0`).
  const bareField = isField && isBareBlockField(ws, primary);
  interface Candidate {
    uri: string;
    range: Range;
    isDecl: boolean;
    symbols: GlslSymbol[];
  }
  const candidates: Candidate[] = [];
  for (const m of models) {
    m.occurrences.forEach((o, i) => {
      if (o.name !== name) return;
      const roleOk = isField ? bareField || o.role === 'member' || o.role === 'declaration' : o.role !== 'member';
      if (!roleOk) return;
      const isDecl = o.role === 'declaration';
      if (isDecl && !includeDeclaration && primary.kind !== 'function') return;
      let symbols: GlslSymbol[] = [];
      if (isDecl && o.symbol) symbols = [o.symbol];
      else {
        const r = resolveOccurrence(ws, m, i);
        if (r && r.kind === 'symbol') symbols = r.symbols;
      }
      if (symbols.length) candidates.push({ uri: m.uri, range: o.range, isDecl, symbols });
    });
  }
  if (primary.kind === 'function') {
    // Overloads split across files: a call site that sees this overload set
    // also sees the others (e.g. a library overload plus the includer's own).
    // Grow the key set until stable so renames stay consistent.
    for (let changed = true; changed; ) {
      changed = false;
      for (const c of candidates) {
        if (c.isDecl || !c.symbols.some((s) => keys.has(symbolKey(s)))) continue;
        for (const s of c.symbols) {
          const k = symbolKey(s);
          if (s.kind === 'function' && !keys.has(k)) {
            keys.add(k);
            changed = true;
          }
        }
      }
    }
  }
  const out: ReferenceLocation[] = [];
  for (const c of candidates) {
    if (c.isDecl && !includeDeclaration) continue;
    if (c.symbols.some((s) => keys.has(symbolKey(s)))) out.push({ uri: c.uri, range: c.range, isDeclaration: c.isDecl });
  }
  return out;
}
