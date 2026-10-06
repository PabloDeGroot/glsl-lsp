// Color decorators: `vec3(1.0, 0.5, 0.2)` / `vec4(...)` literals (and the
// defaults of `#iUniform color3/color4`) get a swatch and a color picker.
//
// A constructor is only offered as a color when all its arguments are numeric
// literals in [0, 1] (one argument = gray) and, in the default 'heuristic'
// mode, when the surrounding code suggests a color: the assignment target,
// enclosing call, or function name contains a word like `col`, `tint`, `sky`.
// Mode 'all' accepts every such literal; 'off' disables the feature.
//
// The mode is read from `glslLsp.colors.mode` (see coreRequests: the setting
// still has to be added to settings.ts/package.json by the integration step).

import type { Color, ColorInformation, ColorPresentation } from 'vscode-languageserver/node';
import type { ServerContext } from '../context';
import type { FileModel, Range } from '../core';

export type ColorsMode = 'heuristic' | 'all' | 'off';

// ---------------------------------------------------------------- literals

const NUMBER_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fF]?$/;

/** Parses a non-negative float literal; undefined for anything else (expressions, negatives). */
export function parseFloatLiteral(text: string): number | undefined {
  const t = text.trim();
  if (!NUMBER_RE.test(t)) return undefined;
  const v = parseFloat(t.replace(/[fF]$/, ''));
  return Number.isFinite(v) ? v : undefined;
}

/** Splits `a, b, c` at top-level commas. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur);
  return out;
}

/** Converts constructor arguments into a color, or undefined when not a plain color literal. */
export function colorFromArgs(ctor: string, args: string[]): Color | undefined {
  const comps = ctor === 'vec3' || ctor === 'color3' ? 3 : ctor === 'vec4' || ctor === 'color4' ? 4 : 0;
  if (!comps) return undefined;
  const vals = args.map(parseFloatLiteral);
  if (vals.some((v) => v === undefined || v < 0 || v > 1)) return undefined;
  const v = vals as number[];
  if (v.length === 1) return { red: v[0], green: v[0], blue: v[0], alpha: comps === 4 ? v[0] : 1 };
  if (v.length !== comps) return undefined;
  return { red: v[0], green: v[1], blue: v[2], alpha: comps === 4 ? v[3] : 1 };
}

// ---------------------------------------------------------------- heuristic

/** Words that make a name a color on their own. */
const STRONG_COLOR_WORDS = new Set([
  'col', 'cols', 'color', 'colors', 'colour', 'colours', 'tint', 'rgb', 'rgba', 'albedo', 'palette', 'hue', 'pigment',
  'ink', 'paint',
]);
/** Words that suggest a color unless a geometry word says otherwise (`lightDir`, `sunPos`). */
const WEAK_COLOR_WORDS = new Set([
  'bg', 'fg', 'light', 'lights', 'sky', 'fog', 'emissive', 'emission', 'emit', 'diffuse', 'specular', 'ambient',
  'background', 'foreground', 'glow', 'fill', 'sun', 'gradient', 'shade', 'stroke',
]);
/** Geometry words: a name containing one is a direction/position, not a color. */
const GEOMETRY_WORDS = new Set([
  'dir', 'dirs', 'direction', 'pos', 'position', 'normal', 'normals', 'nor', 'norm', 'ray', 'ro', 'rd', 'axis', 'up',
  'offset', 'uv', 'vel', 'velocity', 'center', 'centre', 'size', 'scale', 'grad', 'tangent', 'target', 'origin', 'vec',
]);
/** Builtins that use their argument geometrically. */
const GEOMETRIC_CALLEES = new Set(['normalize', 'dot', 'cross', 'reflect', 'refract', 'length', 'distance', 'faceforward']);

/** Splits an identifier into lower-case words: `skyCol_2` -> sky, col. */
export function identifierWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function looksLikeColorName(name: string): boolean {
  const words = identifierWords(name);
  if (words.some((w) => STRONG_COLOR_WORDS.has(w))) return true;
  if (words.some((w) => GEOMETRY_WORDS.has(w))) return false;
  return words.some((w) => WEAK_COLOR_WORDS.has(w));
}

/**
 * Walks backwards from `pos` (start of the constructor) collecting the names
 * that describe where the value ends up: assignment target, enclosing call
 * callees (climbing outwards), a `return` in a named function, `#define` name.
 */
export function contextNames(model: FileModel, pos: number): string[] {
  const text = model.text;
  const names: string[] = [];
  const lineStart = model.lines.lineStarts[model.lines.lineAt(pos)];
  const define = /^\s*#\s*define\s+(\w+)\s*(?:\([^)]*\))?\s*$/.exec(text.slice(lineStart, pos));
  if (define) return [define[1]];

  const limit = Math.max(0, pos - 2000);
  for (let hops = 0; hops < 6; hops++) {
    let depth = 0;
    let i = pos - 1;
    let done = true;
    let stopIdx = -1;
    for (; i >= limit; i--) {
      const ch = text[i];
      if (ch === ')' || ch === ']') depth++;
      else if (ch === '(' || ch === '[') {
        if (depth > 0) {
          depth--;
          continue;
        }
        // Enclosing paren: callee name before it?
        let j = i - 1;
        while (j >= 0 && /\s/.test(text[j])) j--;
        let k = j;
        while (k >= 0 && /\w/.test(text[k])) k--;
        const callee = text.slice(k + 1, j + 1);
        if (ch === '(' && callee && !/^\d/.test(callee)) {
          names.push(callee);
          pos = k + 1;
        } else pos = i;
        done = false;
        break;
      } else if (depth === 0) {
        if (ch === '=') {
          const prev = text[i - 1];
          const next = text[i + 1];
          if (next === '=' || prev === '=' || prev === '!' || prev === '<' || prev === '>') continue;
          const lhs = text.slice(Math.max(0, i - 200), i).replace(/[-+*/%]$/, '').trimEnd();
          const m = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*|\s*\[[^\]]*\])*)$/.exec(lhs);
          if (m) names.push(...m[1].split(/[.[\]\s]+/).filter((s) => /^[A-Za-z_]/.test(s)));
          return names;
        }
        if (ch === ';' || ch === '{' || ch === '}') {
          stopIdx = i;
          break;
        }
      }
    }
    if (done) {
      const seg = text.slice(stopIdx >= 0 ? stopIdx + 1 : Math.max(limit, 0), pos).trim();
      if (/^return\b/.test(seg)) {
        const fn = model.functions.find((f) => {
          const s = model.lines.offsetAt(f.range.start);
          const e = model.lines.offsetAt(f.range.end);
          return s <= pos && pos <= e;
        });
        if (fn) names.push(fn.name);
      }
      return names;
    }
  }
  return names;
}

export function plausiblyColor(model: FileModel, start: number): boolean {
  const names = contextNames(model, start);
  if (names.some((n) => GEOMETRIC_CALLEES.has(n))) return false;
  // Assigned to a float (`float diffuse = ...`): the vector is an operand, not the color.
  return names.some(looksLikeColorName) && !assignsScalar(model, start);
}

/** True when the statement containing `pos` declares a scalar (`float x = ...`). */
function assignsScalar(model: FileModel, pos: number): boolean {
  const text = model.text;
  let i = pos - 1;
  for (; i >= 0; i--) if (text[i] === ';' || text[i] === '{' || text[i] === '}') break;
  return /^\s*(?:const\s+)?(?:float|int|uint|bool|double)\s+\w+\s*=/.test(text.slice(i + 1, pos));
}

// ---------------------------------------------------------------- document colors

/** Pure documentColor computation. */
export function computeDocumentColors(model: FileModel, mode: ColorsMode = 'heuristic'): ColorInformation[] {
  if (mode === 'off') return [];
  const out: ColorInformation[] = [];
  const seen = new Set<number>();

  for (const call of model.calls) {
    if (!call.isConstructor || (call.name !== 'vec3' && call.name !== 'vec4')) continue;
    if (call.closeParen === undefined || call.args.length === 0) continue;
    const args = call.args.map((a) => model.text.slice(model.lines.offsetAt(a.start), model.lines.offsetAt(a.end)));
    const color = colorFromArgs(call.name, args);
    if (!color) continue;
    const start = model.lines.offsetAt(call.range.start);
    if (mode === 'heuristic' && !plausiblyColor(model, start)) continue;
    seen.add(start);
    out.push({ range: call.range, color });
  }

  // `#define SKY_COLOR vec3(...)`: directive bodies are not parsed into calls.
  for (const d of model.directives) {
    if (d.kind !== 'define') continue;
    const txt = model.text.slice(d.start, d.end);
    const head = /^#\s*define\s+(\w+)/.exec(txt);
    if (!head || (mode === 'heuristic' && !looksLikeColorName(head[1]))) continue;
    const re = /\b(vec[34])\s*\(([^()]*)\)/g;
    for (let m = re.exec(txt); m; m = re.exec(txt)) {
      const color = colorFromArgs(m[1], splitArgs(m[2]));
      const start = d.start + m.index;
      if (!color || seen.has(start)) continue;
      seen.add(start);
      out.push({ range: model.lines.range(start, start + m[0].length), color });
    }
  }

  // #iUniform colorN name = colorN(r, g, b)
  for (const d of model.directives) {
    if (d.kind !== 'iUniform') continue;
    const txt = model.text.slice(d.start, d.end);
    if (!/^#\s*iUniform\s+color[34]\b/.test(txt)) continue;
    const eq = txt.indexOf('=');
    if (eq < 0) continue;
    const sub = txt.slice(eq + 1);
    const m = /^(\s*)(color[34]|vec[34])\s*\(([^)]*)\)/.exec(sub);
    if (!m) continue;
    const color = colorFromArgs(m[2], splitArgs(m[3]));
    if (!color) continue;
    const start = d.start + eq + 1 + m[1].length;
    if (seen.has(start)) continue;
    out.push({ range: model.lines.range(start, d.start + eq + 1 + m[0].length), color });
  }
  return out.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

// ---------------------------------------------------------------- presentation

/** Formats a component: <= 3 decimals, trailing zeros trimmed, always a decimal point. */
export function formatComponent(v: number): string {
  let s = (Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000).toFixed(3);
  s = s.replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  return s;
}

/**
 * Text replacing `original` (the current constructor text) for the picked
 * color. Keeps the constructor name, vec3 vs vec4 and the one-argument gray
 * shorthand when the color is still gray.
 */
export function formatColorPresentation(original: string, color: Color): string {
  const m = /^\s*(\w+)\s*\(([\s\S]*)\)\s*$/.exec(original);
  let name = m?.[1] ?? (color.alpha < 1 ? 'vec4' : 'vec3');
  if (!/^(vec[34]|color[34])$/.test(name)) name = color.alpha < 1 ? 'vec4' : 'vec3';
  const hasAlpha = name === 'vec4' || name === 'color4';
  const c = [color.red, color.green, color.blue, ...(hasAlpha ? [color.alpha] : [])].map(formatComponent);
  const sep = m && /,\s/.test(m[2]) ? ', ' : m && /,/.test(m[2]) ? ',' : ', ';
  if (m && splitArgs(m[2]).length === 1 && c.every((x) => x === c[0])) return `${name}(${c[0]})`;
  return `${name}(${c.join(sep)})`;
}

export function computeColorPresentations(originalText: string, color: Color, range: Range): ColorPresentation[] {
  const label = formatColorPresentation(originalText, color);
  return [{ label, textEdit: { range, newText: label } }];
}

export function register(ctx: ServerContext): void {
  const mode = (): ColorsMode => ctx.settings.get().colors.mode;
  ctx.connection.onDocumentColor((params) => {
    try {
      const model = ctx.getModel(params.textDocument.uri);
      return model ? computeDocumentColors(model, mode()) : [];
    } catch (err) {
      ctx.log.error(`documentColor failed: ${(err as Error).stack ?? err}`);
      return [];
    }
  });
  ctx.connection.onColorPresentation((params) => {
    try {
      const doc = ctx.getDocument(params.textDocument.uri);
      const original = doc ? doc.getText(params.range) : (() => {
        const model = ctx.getModel(params.textDocument.uri);
        return model ? model.text.slice(model.lines.offsetAt(params.range.start), model.lines.offsetAt(params.range.end)) : '';
      })();
      return computeColorPresentations(original, params.color, params.range);
    } catch (err) {
      ctx.log.error(`colorPresentation failed: ${(err as Error).stack ?? err}`);
      return [];
    }
  });
}
