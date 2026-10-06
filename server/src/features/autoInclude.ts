// Auto-include: which file to `#include` so that a name becomes visible, and
// the text edit that adds the include line. Shared by completion (items for
// symbols that are not included yet) and code actions ("Add #include").
//
// Candidate rules for a name N used in file F:
//  - N must not already be visible from F (declared in F or its include closure).
//  - A candidate file C declares N (or directly includes a file that does,
//    when C lives in another top-level folder, e.g. `lib/procedural.glsl`
//    re-exporting LYGIA's `gnoise`: the user's own library is preferred).
//    A shader's own multipass common file (only included by entry points in
//    its folder) is not a re-exporter.
//  - C is never F itself, never a file that includes F (that would create a
//    cycle), and never a shader entry point (defines `mainImage`/`main`).
//  - Ordering: re-exporting library files first, then declaring files by
//    path depth/length; files under test/fixture folders sort last.

import type { TextEdit } from 'vscode-languageserver/node';
import {
  hasIncludePath,
  includeInsertionEdit,
  isOptionMacro,
  normalizeUri,
  type FileModel,
  type GlobalSymbol,
  type Workspace,
} from '../core';

export interface IncludeCandidate {
  /** File to include. */
  targetUri: string;
  /** Path text to write inside the quotes (relative to the current file). */
  path: string;
  /** File that actually declares the symbol. */
  declaringUri: string;
  /** True when `targetUri` re-exports the declaring file through its own includes. */
  via: boolean;
}

/** Symbols that may be pulled in through an include (functions, structs, macros, global consts). */
export function isAutoIncludable(s: GlobalSymbol): boolean {
  switch (s.kind) {
    case 'function':
      return !!s.name && s.name !== 'main' && s.name !== 'mainImage';
    case 'struct':
      return !!s.name;
    case 'macro':
      return !s.isIncludeGuard;
    case 'variable':
      return s.storage === 'global' && s.qualifiers.includes('const') && !s.iUniform && !s.iChannel;
    default:
      return false;
  }
}

/** True for files that are shaders themselves rather than libraries. */
export function isEntryPoint(model: FileModel | undefined): boolean {
  if (!model) return false;
  return model.shadertoy.hasMainImage || model.functions.some((f) => f.name === 'main' && !f.isPrototype);
}

const TEST_PATH_RE = /(^|\/)(test|tests|fixtures|__tests__|node_modules)(\/|$)/i;

/**
 * Per-request view of a file's include situation. Build one per completion /
 * code action request: it precomputes the include closure and includers.
 */
export class IncludeContext {
  readonly uri: string;
  /** The file itself plus every file reachable through its includes. */
  readonly closure: Set<string>;
  /** Files that include this file (directly or not): including them would be a cycle. */
  readonly includers: Set<string>;
  private readonly entryCache = new Map<string, boolean>();
  private readonly pathCache = new Map<string, string>();

  constructor(
    readonly ws: Workspace,
    readonly model: FileModel,
  ) {
    this.uri = normalizeUri(model.uri);
    this.closure = new Set([this.uri, ...ws.transitiveIncludes(this.uri)]);
    this.includers = new Set(ws.transitiveIncluders(this.uri));
  }

  isVisibleFile(uri: string): boolean {
    return this.closure.has(uri);
  }

  /** True if including `uri` is allowed (not self, no cycle, not a shader entry point, not already visible). */
  canInclude(uri: string): boolean {
    if (uri === this.uri || this.closure.has(uri) || this.includers.has(uri)) return false;
    let entry = this.entryCache.get(uri);
    if (entry === undefined) {
      entry = isEntryPoint(this.ws.peekModel(uri) ?? this.ws.getModel(uri));
      this.entryCache.set(uri, entry);
    }
    return !entry;
  }

  /** LYGIA option knobs are set before including their file, never auto-included (see core isOptionMacro). */
  isOptionMacro(s: GlobalSymbol): boolean {
    return s.kind === 'macro' && isOptionMacro(this.ws.peekModel(s.uri), s);
  }

  /** Include path text for `target` as written from this file. */
  pathFor(target: string): string {
    let p = this.pathCache.get(target);
    if (p === undefined) {
      p = this.ws.includePathFor(this.uri, target);
      this.pathCache.set(target, p);
    }
    return p;
  }

  /**
   * A shader's own shared pass file (a multipass `common.glsl`): every file
   * that includes it is an entry point in the same folder. Not a library to
   * re-export from, it carries that shader's settings.
   */
  private isPassCommon(uri: string): boolean {
    const includers = this.ws.directIncluders(uri);
    if (!includers.length) return false;
    const dir = this.ws.dirname(uri);
    return includers.every((u) => this.ws.dirname(u) === dir && isEntryPoint(this.ws.peekModel(u) ?? this.ws.getModel(u)));
  }

  private topFolder(uri: string): string {
    const p = this.ws.displayPath(uri);
    const i = p.indexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }

  /**
   * Candidate files to include for `name`. Empty when the name is already
   * visible through includes or nothing eligible declares it.
   * `symbols` defaults to `ws.lookupGlobal(name)`.
   */
  candidatesFor(name: string, symbols?: readonly GlobalSymbol[]): IncludeCandidate[] {
    const all = (symbols ?? this.ws.lookupGlobal(name)).filter((s) => isAutoIncludable(s) && !this.isOptionMacro(s));
    if (!all.length) return [];
    const declaring: string[] = [];
    for (const s of all) {
      if (this.closure.has(s.uri)) return []; // already visible
      if (!declaring.includes(s.uri)) declaring.push(s.uri);
    }
    const out: IncludeCandidate[] = [];
    const seen = new Set<string>();
    for (const d of declaring) {
      if (!this.canInclude(d)) continue;
      const top = this.topFolder(d);
      for (const inc of this.ws.directIncluders(d)) {
        if (seen.has(inc) || !this.canInclude(inc)) continue;
        if (this.topFolder(inc) === top || this.isPassCommon(inc)) continue;
        seen.add(inc);
        out.push({ targetUri: inc, path: this.pathFor(inc), declaringUri: d, via: true });
      }
    }
    for (const d of declaring) {
      if (seen.has(d) || !this.canInclude(d)) continue;
      seen.add(d);
      out.push({ targetUri: d, path: this.pathFor(d), declaringUri: d, via: false });
    }
    return out.sort((a, b) => candidateScore(a) - candidateScore(b) || a.path.localeCompare(b.path));
  }

  /** The edit adding `#include "<path>"` to this file, or undefined if that exact path is already written. */
  includeEdit(path: string): TextEdit | undefined {
    if (hasIncludePath(this.model, path)) return undefined;
    return includeTextEdit(this.model, path);
  }
}

function candidateScore(c: IncludeCandidate): number {
  const depth = c.path.split('/').length;
  let score = depth * 100 + c.path.length;
  if (!c.via) score += 10_000;
  if (TEST_PATH_RE.test(c.path.replace(/^(\.\.\/)+/, ''))) score += 100_000;
  return score;
}

/** Text edit inserting `#include "<path>"` at the conventional place (see core/includeEdit.ts). */
export function includeTextEdit(model: FileModel, path: string): TextEdit {
  const ins = includeInsertionEdit(model, path);
  return { range: { start: ins.position, end: ins.position }, newText: ins.text };
}
