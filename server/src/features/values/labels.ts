// Names and kinds of value targets: declaration / assignment / call argument,
// parameter names, snippets and the color heuristic.

import { BASIC_TYPES, CONTROL_KEYWORDS, isKeyword, lookupName, QUALIFIERS, type FileModel, type FunctionSymbol, type Workspace } from '../../core';
import type { DeclKind, UniformInfo } from '../../../../shared/valuesProtocol';
import { looksLikeColorName, plausiblyColor, type ColorsMode } from '../colors';
import { functionAt, stmtStart } from './analysis';
import type { Analysis, Spec, STok } from './types';

export interface Ctx {
  name?: string;
  declKind: DeclKind;
  functionName?: string;
  uniform?: UniformInfo;
  /** Call argument: the callee (`hsv2rgb`, `mix`). */
  callee?: string;
  /** Direct element of an array constructor `T[N](...)`: the array's name. */
  arrayOf?: string;
}

/**
 * Parameter names that say nothing in a list label (`x`, `y`, `a`, `angle`):
 * the label is composed with the callee and the assigned variable instead.
 */
const GENERIC_PARAMS = new Set(['angle', 'edge', 'value', 'val', 'arg', 'genType', 'in', 'pos', 'vec', 'coord', 'co']);
export function isGenericParam(name: string): boolean {
  return name.length <= 1 || GENERIC_PARAMS.has(name);
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=']);

export interface LabelEnv {
  workspace: Workspace;
}

/** Name of parameter `argIndex` of the callee, from user functions first then builtins. */
function paramName(env: LabelEnv, model: FileModel, callee: string, argIndex: number, argCount: number, offset: number): string | undefined {
  try {
    const found = lookupName(env.workspace, model, callee, offset).symbols;
    const fns = found.filter((s): s is FunctionSymbol => s.kind === 'function');
    if (fns.length) {
      const f = fns.find((s) => s.params.length === argCount) ?? fns[0];
      const n = f.params[argIndex]?.name;
      return n || undefined;
    }
    const entry = env.workspace.builtins.get(callee, env.workspace.builtinFilter(model));
    if (entry && entry.kind === 'function') {
      const o = entry.overloads.find((x) => x.params.length === argCount) ?? entry.overloads.find((x) => x.params.length > argIndex);
      return o?.params[argIndex]?.name || undefined;
    }
  } catch {
    /* labels are best effort */
  }
  return undefined;
}

/** Skips `[ ... ]` groups backwards: returns the index of the token before them. */
function skipIndexBack(a: Analysis, i: number): number {
  while (i >= 0 && a.seq[i].text === ']' && a.match[i] >= 0) i = a.match[i] - 1;
  return i;
}

interface Lhs {
  name: string;
  isDecl: boolean;
  isConst: boolean;
}

/** Analyses the left-hand side of the assignment operator at token `eq`. */
function lhsOf(a: Analysis, eq: number, from: number): Lhs | undefined {
  const seq = a.seq;
  let n = skipIndexBack(a, eq - 1);
  if (n < from || seq[n]?.kind !== 'ident') return undefined;
  // member chain: a.b.c / a[i].b -> base
  for (;;) {
    if (n - 1 >= from && seq[n - 1].text === '.') {
      const m = skipIndexBack(a, n - 2);
      if (m >= from && seq[m].kind === 'ident') {
        n = m;
        continue;
      }
    }
    break;
  }
  const name = seq[n].text;
  const prev = n - 1 >= from ? seq[n - 1] : undefined;
  if (prev && prev.kind === 'ident' && !CONTROL_KEYWORDS.has(prev.text) && prev.text !== 'struct') {
    let isConst = false;
    for (let k = n - 1; k >= from && seq[k].kind === 'ident'; k--) if (seq[k].text === 'const') isConst = true;
    return { name, isDecl: BASIC_TYPES.has(prev.text) || QUALIFIERS.has(prev.text) || !isKeyword(prev.text), isConst };
  }
  if (prev && prev.text === ',') {
    // `float a = 1.0, b = 2.0;`: look at the statement head.
    const head = declHead(a, from);
    if (head) return { name, isDecl: true, isConst: head.isConst };
  }
  return { name, isDecl: false, isConst: false };
}

/** `[qualifiers] Type name ...` at statement start. */
function declHead(a: Analysis, from: number): { isConst: boolean } | undefined {
  const seq = a.seq;
  let i = from;
  let isConst = false;
  let idents = 0;
  while (i < seq.length && seq[i].kind === 'ident' && seq[i].region === seq[from].region) {
    if (CONTROL_KEYWORDS.has(seq[i].text)) return undefined;
    if (seq[i].text === 'const') isConst = true;
    idents++;
    i++;
  }
  return idents >= 2 ? { isConst } : undefined;
}

/** Skips a leading `if (...)`, `else`, `while (...)`, `for (` so declarations after it are seen as a statement head. */
function skipControl(a: Analysis, from: number, limit: number): number {
  const seq = a.seq;
  let i = from;
  while (i < limit && seq[i].kind === 'ident' && CONTROL_KEYWORDS.has(seq[i].text)) {
    const w = seq[i].text;
    if (w === 'else' || w === 'do') {
      i++;
      continue;
    }
    if ((w === 'if' || w === 'while' || w === 'for' || w === 'switch') && seq[i + 1]?.text === '(') {
      const close = a.match[i + 1];
      i = close > i && close < limit ? close + 1 : i + 2;
      continue;
    }
    break;
  }
  return i;
}

/** Context of the value spanning tokens [startTok, endTok]. */
export function contextOf(env: LabelEnv, a: Analysis, startTok: number, endTok: number): Ctx {
  const seq = a.seq;
  const t0 = seq[startTok];
  const model = a.model;
  if (t0.region >= 0) {
    const d = a.dirs[t0.region];
    if (d.kind === 'define') return { name: d.name, declKind: 'define' };
    const u: UniformInfo = { declaredType: d.declaredType ?? 'float' };
    if (d.min !== undefined) u.min = d.min;
    if (d.max !== undefined) u.max = d.max;
    if (d.step !== undefined) u.step = d.step;
    return { name: d.name, declKind: 'iUniform', uniform: u };
  }
  const functionName = functionAt(a, t0.start);
  const base: Ctx = { declKind: 'expression', functionName };
  let depth = 0;
  let commas = 0;
  /** Innermost enclosing paren seen (only that one can make the value an array element). */
  let firstParen = true;
  let arrayIndex: number | undefined;
  const limit = Math.max(0, startTok - 700);
  for (let i = startTok - 1; i >= limit; i--) {
    const t = seq[i];
    if (t.region !== t0.region) break;
    if (t.kind !== 'punct') continue;
    const c = t.text;
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      if (depth > 0) {
        depth--;
        continue;
      }
      const callee = c === '(' && i > 0 && seq[i - 1].region === t.region ? seq[i - 1] : undefined;
      if (callee && callee.kind === 'ident' && !isKeyword(callee.text) && !/^color[34]$/.test(callee.text)) {
        // call argument
        const argCount = a.match[i] > i ? argCountOf(a, i) : commas + 1;
        const pn = paramName(env, model, callee.text, commas, argCount, callee.start);
        let name = pn ?? callee.text;
        if (pn && isGenericParam(pn)) {
          // `normalize(x)`, `mix(.., y, ..)`: name the value after what it feeds instead.
          const call = argCount > 1 ? `${callee.text}(${pn})` : callee.text;
          const owner = statementName(a, stmtStart(seq, a.match, i), i).name;
          name = owner ? `${owner} · ${call}` : call;
        }
        return { ...base, name, declKind: 'argument', callee: callee.text };
      }
      // Direct element of an array constructor `vec3[17](a, b, ...)`: element `commas`.
      if (firstParen && c === '(' && i > 0 && seq[i - 1].text === ']' && a.match[i - 1] > 0 && seq[a.match[i - 1] - 1]?.kind === 'ident') {
        const after = seq[endTok + 1]?.text;
        const before = seq[startTok - 1]?.text;
        if ((before === '(' || before === ',') && (after === ',' || after === ')')) arrayIndex = commas;
      }
      firstParen = false;
      commas = 0; // constructor, grouping, if(...) etc.: transparent
    } else if (c === ',' && depth === 0) commas++;
    else if (c === ';' || c === '{' || c === '}') {
      if (depth === 0 || c !== ';') break;
    } else if (depth === 0 && ASSIGN_OPS.has(c)) {
      const from = skipControl(a, stmtStart(seq, a.match, i), i);
      const lhs = lhsOf(a, i, from);
      if (!lhs) return base;
      // exact initializer?
      const next = seq[endTok + 1];
      const exact =
        startTok === i + 1 && (!next || next.region !== t0.region || next.text === ';' || next.text === ',' || next.text === ')');
      let declKind: DeclKind = 'assignment';
      if (exact && lhs.isDecl) declKind = lhs.isConst ? 'const' : functionName ? 'local' : 'global';
      if (arrayIndex !== undefined && lhs.isDecl) {
        // `const vec3 lut[17] = vec3[17](...)`: the element is `lut[i]` of a declaration.
        return { ...base, name: `${lhs.name}[${arrayIndex}]`, declKind: lhs.isConst ? 'const' : functionName ? 'local' : 'global', arrayOf: lhs.name };
      }
      return { ...base, name: lhs.name, declKind };
    }
  }
  return base;
}

function argCountOf(a: Analysis, open: number): number {
  const close = a.match[open];
  let n = 1;
  let depth = 0;
  if (close === open + 1) return 0;
  for (let i = open + 1; i < close; i++) {
    const c = a.seq[i].text;
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) n++;
  }
  return n;
}

/** Name of the assignment / declaration a statement makes (for multi targets). */
export function statementName(a: Analysis, from: number, to: number): { name?: string; declKind: DeclKind } {
  const seq = a.seq;
  const t0 = seq[from];
  if (t0.region >= 0) {
    const d = a.dirs[t0.region];
    return { name: d.name, declKind: d.kind === 'define' ? 'define' : 'iUniform' };
  }
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = seq[i].text;
    if (seq[i].kind !== 'punct') continue;
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth <= 0 && ASSIGN_OPS.has(c)) {
      const lhs = lhsOf(a, i, skipControl(a, from, i));
      if (!lhs) return { declKind: 'expression' };
      // `float sum = 0.0, amp = 0.5;` / `const vec3 lut[3] = ...`: a declaration, anchored by name.
      if (lhs.isDecl && c === '=') return { name: lhs.name, declKind: lhs.isConst ? 'const' : functionAt(a, seq[i].start) ? 'local' : 'global' };
      return { name: lhs.name, declKind: 'assignment' };
    }
  }
  return { declKind: 'expression' };
}

// ---------------------------------------------------------------- snippets

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function clip(text: string, max = 48): string {
  const t = collapse(text);
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

/** Snippet around [start, end) of the document text: the code of the statement, windowed. */
export function windowSnippet(text: string, start: number, end: number, max = 48): string {
  const raw = text.slice(start, end);
  const t = collapse(raw);
  if (t.length >= 8 || t.length === 0) return clip(t, max);
  // Short targets (a lone number) say little: show the surrounding line.
  let ls = text.lastIndexOf('\n', start - 1) + 1;
  let le = text.indexOf('\n', end);
  if (le < 0) le = text.length;
  const lineStart = ls;
  const line = text.slice(lineStart, le);
  const rel = start - lineStart;
  const lead = line.length - line.trimStart().length;
  ls = Math.max(lead, rel - 18);
  const body = collapse(line.slice(ls, Math.min(line.length, rel + max - 18)));
  const prefix = ls > lead ? '…' : '';
  return prefix + (prefix.length + body.length > max ? body.slice(0, max - prefix.length - 1) + '…' : body);
}

// ---------------------------------------------------------------- color heuristic

export function isColorish(
  a: Analysis,
  mode: ColorsMode,
  spec: Spec,
  ctx: Ctx,
  values: { value: number; editable: boolean }[],
): boolean {
  if (spec.kind === 'palette') return true;
  if (spec.kind !== 'vec3' && spec.kind !== 'vec4') return false;
  // iq palette coefficients: a (offset) and b (amplitude) are colors, c (frequency) and d (phase) are not.
  if (spec.paletteRole) return spec.paletteRole === 'a' || spec.paletteRole === 'b';
  if (ctx.uniform && /^color[34]$/.test(ctx.uniform.declaredType)) return true;
  if (spec.vec && /^color[34]$/.test(spec.vec.ctor)) return true;
  if (mode === 'all') return values.every((v) => !v.editable || (v.value >= 0 && v.value <= 1));
  if (ctx.uniform) return looksLikeColorName(ctx.name ?? '');
  // `hsv2rgb(vec3(h, s, v))`: the argument is HSV/HSL/Lab..., not RGB (the callee name says "rgb").
  if (ctx.callee && NON_RGB_INPUT.test(ctx.callee)) return false;
  const unit = values.every((v) => !v.editable || (v.value >= 0 && v.value <= 1));
  // Color map stops: `const vec3 lut[17] = vec3[17](...)` inside turbo()/inferno()/... or a color file.
  if (ctx.arrayOf && unit && (COLORMAP_RE.test(ctx.arrayOf) || COLORMAP_RE.test(ctx.functionName ?? '') || /colou?r/i.test(fileBase(a.model.uri)))) return true;
  const output = flowsIntoOutput(a, spec, ctx);
  // A self-feeding buffer pass (`#iChannel0 "self"`) writes data, not colors.
  if (output && SELF_BUFFER_RE.test(a.model.text)) return false;
  if (plausiblyColor(a.model, spec.start)) return true;
  return output && unit;
}

/** Color conversions whose INPUT is not RGB: hsv2rgb, hsl2rgb, lab2rgb, oklabToRgb, hsv(...). */
const NON_RGB_INPUT = /^(?:hsv|hsl|hsb|hcl|hcy|hsluv|lab|lch|oklab|oklch|luv|yuv|yiq|ycbcr|ycocg|xyz|cmyk)(?:2|To|_to_|$)/i;
const COLORMAP_RE = /colou?r|map|lut|turbo|inferno|magma|viridis|plasma|cividis|palette|pal$|ramp|grad|heat|spectr|rainbow|jet|stops?$/i;
const SELF_BUFFER_RE = /#\s*iChannel\d+\s+"self"/;
const OUTPUT_RE = /^(?:fragColor|gl_FragColor|FragColor|fragColour|outColor|out_color|o_color|oColor|finalColor|color_out)$/;

function fileBase(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

/**
 * True when the value is the variable (or the right-hand side) that later
 * reaches the shader output: `c = cond ? vec3(..) : vec3(..); fragColor = vec4(c, 1.0);`
 * or `fragColor = vec4(...)` itself.
 */
function flowsIntoOutput(a: Analysis, spec: Spec, ctx: Ctx): boolean {
  const seq = a.seq;
  if (seq[spec.startTok].region !== -1) return false;
  const name = ctx.name;
  if (!name || (ctx.declKind !== 'assignment' && ctx.declKind !== 'local' && ctx.declKind !== 'global')) return false;
  if (OUTPUT_RE.test(name)) return true;
  if (!/^[A-Za-z_]\w*$/.test(name)) return false;
  const fnEnd = a.fns.find((f) => f.start <= spec.start && spec.start <= f.end)?.end ?? Infinity;
  const limit = Math.min(seq.length, spec.endTok + 4000);
  for (let k = spec.endTok + 1; k < limit; k++) {
    const t = seq[k];
    if (t.start > fnEnd) break;
    if (t.kind !== 'ident' || !OUTPUT_RE.test(t.text)) continue;
    let j = k + 1;
    if (seq[j]?.text === '.' && seq[j + 1]?.kind === 'ident') j += 2;
    if (!seq[j] || !ASSIGN_OPS.has(seq[j].text)) continue;
    for (let m = j + 1; m < limit && seq[m].text !== ';'; m++) {
      if (seq[m].kind === 'ident' && seq[m].text === name && seq[m - 1]?.text !== '.') return true;
    }
  }
  return false;
}

export type { STok };
