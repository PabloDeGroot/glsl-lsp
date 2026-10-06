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

export * from './types';

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

/** Shared registry built from all data files. */
export function getBuiltins(): Builtins {
  return (defaultInstance ??= new Builtins(builtinData));
}
