// #include resolution and the include graph.
//
// Resolution order for `#include "p"` in file F:
//   1. relative to F's directory          (shader-toy extension semantics)
//   2. each configured include path        (absolute, or relative to each root)
//   3. each workspace root
// Absolute paths are used as is. Angle-bracket includes use the same order.

import type { FileSystem } from './fs';
import { dirnameUri, fsPathToUri, isAbsolutePath, isUnder, relativePath, resolveUri, uriToFsPath } from './uri';

export interface IncludeResolverOptions {
  fs: FileSystem;
  /** Workspace folder URIs. */
  roots: string[];
  /** Extra include directories: absolute paths/URIs, or relative to each root. */
  includePaths: string[];
  /**
   * Known documents (open buffers, indexed files): returns the key under
   * which `uri` is known (it may differ in case on case-insensitive file
   * systems), or undefined.
   */
  known?: (uri: string) => string | undefined;
}

export class IncludeResolver {
  constructor(private options: IncludeResolverOptions) {}

  update(options: Partial<IncludeResolverOptions>) {
    this.options = { ...this.options, ...options };
  }

  get roots(): string[] {
    return this.options.roots;
  }

  /** Directories searched after the including file's own directory. */
  searchDirs(): string[] {
    const dirs: string[] = [];
    for (const p of this.options.includePaths) {
      if (p.startsWith('file:')) dirs.push(p);
      else if (isAbsolutePath(p)) dirs.push(fsPathToUri(p));
      else for (const root of this.options.roots) dirs.push(resolveUri(root, p));
    }
    dirs.push(...this.options.roots);
    return dirs;
  }

  /** The URI under which `uri` exists (known key or on-disk spelling), or undefined. */
  private existing(uri: string): string | undefined {
    const key = this.options.known?.(uri);
    if (key) return key;
    if (!this.options.fs.exists(uri)) return undefined;
    return this.options.fs.canonical?.(uri) ?? uri;
  }

  /** Resolved URI of `path` included from `fromUri`, or undefined. */
  resolve(fromUri: string, path: string): string | undefined {
    if (!path) return undefined;
    if (isAbsolutePath(path)) return this.existing(fsPathToUri(path));
    const candidates = [resolveUri(dirnameUri(fromUri), path), ...this.searchDirs().map((d) => resolveUri(d, path))];
    for (const c of candidates) {
      const hit = this.existing(c);
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * The path text to write in `#include "..."` inside `fromUri` so it resolves
   * to `targetUri`. Prefers a path relative to the including file (the
   * shader-toy convention), falling back to an include-path-relative path,
   * then an absolute path.
   */
  includePathFor(fromUri: string, targetUri: string): string {
    const rel = relativePath(dirnameUri(fromUri), targetUri);
    if (rel !== undefined) return rel;
    for (const dir of this.searchDirs()) {
      if (isUnder(dir, targetUri)) {
        const r = relativePath(dir, targetUri);
        if (r) return r;
      }
    }
    return uriToFsPath(targetUri).replace(/\\/g, '/');
  }
}

/** Directed graph uri -> resolved include uris, with reverse edges and cached closures. */
export class IncludeGraph {
  private readonly edges = new Map<string, string[]>();
  private readonly reverse = new Map<string, Set<string>>();
  private closureCache = new Map<string, string[]>();
  private closureSetCache = new Map<string, Set<string>>();

  setEdges(uri: string, targets: string[]) {
    for (const old of this.edges.get(uri) ?? []) this.reverse.get(old)?.delete(uri);
    this.edges.set(uri, targets);
    for (const t of targets) {
      let set = this.reverse.get(t);
      if (!set) this.reverse.set(t, (set = new Set()));
      set.add(uri);
    }
    this.closureCache.clear();
    this.closureSetCache.clear();
  }

  remove(uri: string) {
    this.setEdges(uri, []);
    this.edges.delete(uri);
  }

  direct(uri: string): string[] {
    return this.edges.get(uri) ?? [];
  }

  directIncluders(uri: string): string[] {
    return [...(this.reverse.get(uri) ?? [])];
  }

  /**
   * Every file reachable through includes from `uri`, depth-first in include
   * order, excluding `uri` itself. Cycle-safe. `load` lets the caller pull in
   * files that are not in the graph yet (lazy loading).
   */
  closure(uri: string, load?: (uri: string) => void): string[] {
    const cached = this.closureCache.get(uri);
    if (cached) return cached;
    const seen = new Set<string>([uri]);
    const order: string[] = [];
    const visit = (u: string) => {
      if (!this.edges.has(u)) load?.(u);
      for (const t of this.edges.get(u) ?? []) {
        if (seen.has(t)) continue;
        seen.add(t);
        order.push(t);
        visit(t);
      }
    };
    visit(uri);
    this.closureCache.set(uri, order);
    return order;
  }

  /** `closure(uri)` as a Set (cached alongside the closure) for fast membership tests. */
  closureSet(uri: string, load?: (uri: string) => void): ReadonlySet<string> {
    let set = this.closureSetCache.get(uri);
    if (!set) {
      set = new Set(this.closure(uri, load));
      this.closureSetCache.set(uri, set);
    }
    return set;
  }

  /** Every file that includes `uri` directly or indirectly. */
  includers(uri: string): string[] {
    const seen = new Set<string>([uri]);
    const order: string[] = [];
    const stack = [uri];
    while (stack.length) {
      const u = stack.pop()!;
      for (const i of this.reverse.get(u) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        order.push(i);
        stack.push(i);
      }
    }
    return order;
  }

  invalidate() {
    this.closureCache.clear();
    this.closureSetCache.clear();
  }
}
