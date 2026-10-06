// Helpers that keep the builtin data files compact. A function is declared
// with GLSL-looking signature strings:
//
//   fn('mix', 'common', 'Linearly interpolate...', [
//     'genType mix(genType x, genType y, float a)',
//     '@130 genType mix(genType x, genType y, genBType a)',   // '@130' = minVersion
//   ])
//
// Parameters may carry a leading qualifier (`out genType i`).

import type { BuiltinFunction, BuiltinOverload, BuiltinParam, ShaderStage } from './types';

export const KHRONOS = 'https://registry.khronos.org/OpenGL-Refpages/gl4/html/';

export interface FnOptions {
  minVersion?: number;
  stages?: ShaderStage[];
  /** Khronos page name when it differs from the function name; `false` for none. */
  docPage?: string | false;
  deprecated?: string;
  shadertoy?: boolean;
  requiresDirective?: 'iKeyboard';
  snippet?: string;
  /** Per-parameter docs by name. */
  params?: Record<string, string>;
}

/** Parses `[@version] ret name(qual type pname, ...)`. */
export function parseSignature(sig: string, paramDocs?: Record<string, string>): { name: string; overload: BuiltinOverload } {
  const m = /^(?:@(\d+)\s+)?(\S+)\s+(\w+)\s*\((.*)\)\s*$/.exec(sig.trim());
  if (!m) throw new Error(`Bad builtin signature: ${sig}`);
  const [, ver, returnType, name, rawParams] = m;
  const params: BuiltinParam[] = [];
  for (const raw of rawParams.split(',').map((s) => s.trim()).filter(Boolean)) {
    const words = raw.split(/\s+/);
    const pname = words.pop() as string;
    const type = words.pop() as string;
    const p: BuiltinParam = { name: pname, type };
    const q = words[0];
    if (q === 'out' || q === 'inout' || q === 'in') p.qualifier = q;
    if (paramDocs?.[pname]) p.doc = paramDocs[pname];
    params.push(p);
  }
  const overload: BuiltinOverload = { returnType, params };
  if (ver) overload.minVersion = Number(ver);
  return { name, overload };
}

export function fn(name: string, category: string, doc: string, sigs: string[], opts: FnOptions = {}): BuiltinFunction {
  const overloads = sigs.map((s) => {
    const parsed = parseSignature(s, opts.params);
    if (parsed.name !== name) throw new Error(`Signature ${s} does not match ${name}`);
    return parsed.overload;
  });
  const f: BuiltinFunction = { kind: 'function', name, category, doc, overloads };
  if (opts.docPage !== false) f.docUrl = KHRONOS + (opts.docPage ?? name) + '.xhtml';
  const v = opts.minVersion ?? undefined;
  if (v) f.minVersion = v;
  if (opts.stages) f.stages = opts.stages;
  if (opts.deprecated) f.deprecated = opts.deprecated;
  if (opts.shadertoy) f.shadertoy = true;
  if (opts.requiresDirective) f.requiresDirective = opts.requiresDirective;
  if (opts.snippet) f.snippet = opts.snippet;
  return f;
}

/** Looks up several one-line docs: `docs({ sin: '...', cos: '...' })`. */
export type DocTable = Record<string, string>;
