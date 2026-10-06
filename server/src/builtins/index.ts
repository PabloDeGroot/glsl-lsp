// Builtin registry. Aggregates the data files in this folder; add a new data
// file by exporting arrays of the types in ./types and appending them below.

import { builtinDirectives } from './directives';
import { builtinFunctions } from './functions';
import { builtinKeywords } from './keywords';
import { builtinMacros } from './macros';
import { layoutQualifiers } from './layout';
import { keyboardVariables, shadertoyFunctions, shadertoyVariables } from './shadertoy';
import { builtinTypes } from './typesData';
import type {
  BuiltinData,
  BuiltinDirective,
  BuiltinEntry,
  BuiltinFunction,
  BuiltinKeyword,
  BuiltinMacro,
  BuiltinType,
  BuiltinVariable,
} from './types';
import { builtinVariables } from './variables';
import { BASIC_TYPES, invalidIdentifierReason, isKeyword, RESERVED_WORDS } from '../core/keywords';

export * from './types';

/** A uniform the shader runtime provides (glslLsp.environment.uniforms). */
export interface EnvironmentUniform {
  name: string;
  /** GLSL type, arrays as `vec4[16]`. */
  type: string;
  /** Markdown shown on hover and completion. */
  doc?: string;
}

/** What the shader runtime provides beyond GLSL (glslLsp.environment.*). */
export interface Environment {
  uniforms: EnvironmentUniform[];
  /** name -> replacement text (may be empty). */
  defines: Record<string, string>;
}

const IDENT = /^[A-Za-z_]\w*$/;
const ENV_TYPE = /^([A-Za-z_]\w*)(\[[1-9]\d*\])?$/;

/** A GLSL builtin type (not `void`), optionally a sized array: `vec4`, `vec4[16]`. */
function validEnvType(type: string): boolean {
  const m = ENV_TYPE.exec(type);
  return !!m && m[1] !== 'void' && BASIC_TYPES.has(m[1]);
}

/** Valid as a macro name: an identifier that is not a keyword or reserved, and not `GL_` / `__`. */
function validDefineName(name: string): boolean {
  return IDENT.test(name) && !isKeyword(name) && !RESERVED_WORDS.has(name) && !name.startsWith('GL_') && !name.includes('__');
}

/**
 * Drops malformed entries: names that are not valid user identifiers
 * (keywords, reserved words, `gl_` / `__`), types that are not GLSL builtin
 * types, duplicates (the first wins). Define values are flattened to one
 * line and lose a trailing backslash (it would continue the line).
 */
export function sanitizeEnvironment(env: Partial<Environment> | undefined): Environment {
  const uniforms: EnvironmentUniform[] = [];
  const seen = new Set<string>();
  for (const u of Array.isArray(env?.uniforms) ? env!.uniforms : []) {
    if (!u || typeof u !== 'object') continue;
    const name = typeof u.name === 'string' ? u.name.trim() : '';
    const type = typeof u.type === 'string' ? u.type.trim().replace(/\s+/g, '') : '';
    if (invalidIdentifierReason(name) || !validEnvType(type) || seen.has(name)) continue;
    seen.add(name);
    uniforms.push(typeof u.doc === 'string' && u.doc.trim() ? { name, type, doc: u.doc } : { name, type });
  }
  const defines: Record<string, string> = {};
  const raw = env?.defines;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [name, value] of Object.entries(raw)) {
      if (!validDefineName(name)) continue;
      if (typeof value === 'string') defines[name] = value.replace(/[\r\n]+/g, ' ').trim().replace(/\\+$/, '').trim();
      else if (typeof value === 'number' || typeof value === 'boolean') defines[name] = String(value);
    }
  }
  return { uniforms, defines };
}

/** `vec4[16]` -> { base: 'vec4', array: '[16]' }. */
export function splitArrayType(type: string): { base: string; array: string } {
  const m = /^(\w+)\s*(\[\s*\d+\s*\])?$/.exec(type.trim());
  return m ? { base: m[1], array: (m[2] ?? '').replace(/\s+/g, '') } : { base: type, array: '' };
}

export interface BuiltinFilter {
  /** Include Shadertoy-only entries. Default true. */
  shadertoy?: boolean;
  /** Directives present in the file (e.g. 'iKeyboard'); entries requiring others are hidden. Undefined = show all. */
  directives?: Set<string>;
  /** Hide entries whose minVersion is above this. Undefined = no filter. */
  version?: number;
}

export class Builtins {
  readonly functions = new Map<string, BuiltinFunction>();
  readonly variables = new Map<string, BuiltinVariable>();
  readonly types = new Map<string, BuiltinType>();
  readonly keywords = new Map<string, BuiltinKeyword>();
  readonly directives = new Map<string, BuiltinDirective>();
  readonly macros = new Map<string, BuiltinMacro>();
  /** Identifiers valid inside `layout(...)`. */
  readonly layoutQualifiers = new Map<string, BuiltinKeyword>();
  /** The configured environment (see setEnvironment). */
  private env: Environment = { uniforms: [], defines: {} };
  /** Entries an environment entry of the same name replaced, restored by the next setEnvironment. */
  private readonly shadowed: { variables: BuiltinVariable[]; macros: BuiltinMacro[] } = { variables: [], macros: [] };

  constructor(data: BuiltinData) {
    for (const f of data.functions) {
      const existing = this.functions.get(f.name);
      // Data files may split one function across entries: merge overloads.
      if (existing) existing.overloads.push(...f.overloads);
      else this.functions.set(f.name, { ...f, overloads: [...f.overloads] });
    }
    for (const v of data.variables) this.variables.set(v.name, v);
    for (const t of data.types) this.types.set(t.name, t);
    for (const k of data.keywords) this.keywords.set(k.name, k);
    for (const d of data.directives) this.directives.set(d.name, d);
    for (const m of data.macros) this.macros.set(m.name, m);
    for (const l of data.layoutQualifiers ?? []) this.layoutQualifiers.set(l.name, l);
  }

  /** The uniforms and defines of the configured shader runtime. */
  get environment(): Environment {
    return this.env;
  }

  /**
   * Replaces the environment uniforms and defines (glslLsp.environment.*).
   * They behave like builtins everywhere (hover, completion, semantic tokens,
   * the undeclared check) and are declared in the glslang preamble. An entry
   * named like a builtin replaces it until the environment changes again.
   */
  setEnvironment(raw: Partial<Environment> | undefined): void {
    const env = sanitizeEnvironment(raw);
    for (const [name, v] of this.variables) if (v.environment) this.variables.delete(name);
    for (const [name, m] of this.macros) if (m.environment) this.macros.delete(name);
    for (const v of this.shadowed.variables) this.variables.set(v.name, v);
    for (const m of this.shadowed.macros) this.macros.set(m.name, m);
    this.shadowed.variables = [];
    this.shadowed.macros = [];
    for (const u of env.uniforms) {
      const old = this.variables.get(u.name);
      if (old) this.shadowed.variables.push(old);
      this.variables.set(u.name, { kind: 'variable', name: u.name, type: u.type, qualifiers: ['uniform'], doc: u.doc ?? '', environment: true });
    }
    for (const [name, value] of Object.entries(env.defines)) {
      const old = this.macros.get(name);
      if (old) this.shadowed.macros.push(old);
      this.macros.set(name, { kind: 'macro', name, value, doc: '', environment: true });
    }
    this.env = env;
  }

  /** Any builtin entry by name (function > variable > type > macro > keyword). */
  get(name: string, filter?: BuiltinFilter): BuiltinEntry | undefined {
    const candidates: (BuiltinEntry | undefined)[] = [
      this.functions.get(name),
      this.variables.get(name),
      this.types.get(name),
      this.macros.get(name),
      this.keywords.get(name),
    ];
    return candidates.find((e) => e && this.passes(e, filter));
  }

  /** True if `entry` is visible under `filter`. */
  passes(entry: BuiltinEntry, filter?: BuiltinFilter): boolean {
    if (!filter) return true;
    if ('shadertoy' in entry && entry.shadertoy && filter.shadertoy === false) return false;
    if ('requiresDirective' in entry && entry.requiresDirective && filter.directives && !filter.directives.has(entry.requiresDirective)) {
      return false;
    }
    if ('minVersion' in entry && entry.minVersion && filter.version && entry.minVersion > filter.version) return false;
    return true;
  }

  allFunctions(filter?: BuiltinFilter): BuiltinFunction[] {
    return [...this.functions.values()].filter((e) => this.passes(e, filter));
  }

  allVariables(filter?: BuiltinFilter): BuiltinVariable[] {
    return [...this.variables.values()].filter((e) => this.passes(e, filter));
  }

  allTypes(filter?: BuiltinFilter): BuiltinType[] {
    return [...this.types.values()].filter((e) => this.passes(e, filter));
  }

  allDirectives(filter?: BuiltinFilter): BuiltinDirective[] {
    return [...this.directives.values()].filter((e) => this.passes(e, filter));
  }
}

export const builtinData: BuiltinData = {
  functions: [...builtinFunctions, ...shadertoyFunctions],
  variables: [...builtinVariables, ...shadertoyVariables, ...keyboardVariables],
  types: builtinTypes,
  keywords: builtinKeywords,
  directives: builtinDirectives,
  macros: builtinMacros,
  layoutQualifiers,
};

let defaultInstance: Builtins | undefined;

/**
 * Shared registry built from all data files, for code that never configures
 * an environment (tests, tools). The server creates its own instance.
 */
export function getBuiltins(): Builtins {
  return (defaultInstance ??= new Builtins(builtinData));
}
