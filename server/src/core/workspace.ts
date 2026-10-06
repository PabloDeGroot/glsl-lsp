// The Workspace: every known FileModel, kept in sync with open buffers and
// the disk, plus the include graph, a global symbol table and the symbol
// resolution entry points (implemented in resolve.ts).
//
// Open-buffer text always wins over disk contents. Files outside the indexed
// roots (e.g. reached through includePaths) are loaded lazily on demand.

import type { BuiltinFilter, Builtins } from '../builtins';
import type { FileSystem } from './fs';
import { IncludeGraph, IncludeResolver } from './includes';
import { isGlslPath } from './keywords';
import type { FileModel, GlobalSymbol } from './model';
import { parse } from './parser';
import * as resolve from './resolve';
import type { Position } from './text';
import { dirnameUri, isUnder, normalizeUri, relativePath, resolveUri, uriToFsPath } from './uri';

export interface WorkspaceOptions {
  fs: FileSystem;
  builtins: Builtins;
  /** Workspace folder URIs. */
  roots?: string[];
  includePaths?: string[];
  /**
   * Directories skipped when indexing: a bare name (`node_modules`) matches
   * that folder anywhere; an entry with a `/` (`glsl-lsp/test/fixtures`)
   * matches a path relative to a workspace root, or the end of one.
   */
  exclude?: string[];
  maxFiles?: number;
  /** Shadertoy builtins visible. */
  shadertoy?: boolean;
}

export interface ModelChangeEvent {
  uri: string;
  /** The new model, or undefined when the file was removed. */
  model?: FileModel;
  /** `uri` plus every file that (transitively) includes it. */
  affected: string[];
  /** The change came from the disk (watched file, index, re-resolution), not from editing an open buffer. */
  fromDisk?: boolean;
  /** The set of top-level names the file declares changed (or the file appeared/disappeared). */
  namesChanged?: boolean;
}

export interface IndexStats {
  files: number;
  ms: number;
}

const DEFAULT_EXCLUDE = ['node_modules', '.git', 'out', 'dist', '.vscode-test'];

/** A directory containing this file (and everything below it) is never indexed. */
export const IGNORE_MARKER = '.glsl-lsp-ignore';

export class Workspace {
  readonly fs: FileSystem;
  readonly builtins: Builtins;
  readonly resolver: IncludeResolver;
  readonly graph = new IncludeGraph();

  private roots: string[];
  private exclude: Set<string>;
  private maxFiles: number;
  shadertoy: boolean;

  private readonly models = new Map<string, FileModel>();
  private readonly openUris = new Set<string>();
  /** name -> global symbols across every model. */
  private readonly byName = new Map<string, GlobalSymbol[]>();
  private readonly listeners = new Set<(e: ModelChangeEvent) => void>();
  /** URIs that failed to load (avoid retrying on every lookup). */
  private readonly missing = new Set<string>();
  /** Lower-cased URI -> model key, on case-insensitive file systems. */
  private readonly lowerKeys = new Map<string, string>();

  constructor(options: WorkspaceOptions) {
    this.fs = options.fs;
    this.builtins = options.builtins;
    this.roots = (options.roots ?? []).map(normalizeUri);
    this.exclude = new Set(options.exclude ?? DEFAULT_EXCLUDE);
    this.maxFiles = options.maxFiles ?? 10000;
    this.shadertoy = options.shadertoy ?? true;
    this.resolver = new IncludeResolver({
      fs: this.fs,
      roots: this.roots,
      includePaths: options.includePaths ?? [],
      known: (uri) => (this.models.has(uri) ? uri : this.fs.caseInsensitive ? this.lowerKeys.get(uri.toLowerCase()) : undefined),
    });
  }

  // ------------------------------------------------------------ configuration

  configure(options: Partial<Pick<WorkspaceOptions, 'roots' | 'includePaths' | 'exclude' | 'maxFiles' | 'shadertoy'>>) {
    if (options.roots) this.roots = options.roots.map(normalizeUri);
    if (options.exclude) this.exclude = new Set(options.exclude);
    if (options.maxFiles !== undefined) this.maxFiles = options.maxFiles;
    if (options.shadertoy !== undefined) this.shadertoy = options.shadertoy;
    if (options.roots || options.includePaths) {
      this.resolver.update({ roots: this.roots, ...(options.includePaths ? { includePaths: options.includePaths } : {}) });
      this.missing.clear();
      this.emitResolutionChanges(this.reresolveAll());
    }
  }

  get workspaceRoots(): readonly string[] {
    return this.roots;
  }

  /** Filter for builtins according to settings and the file's directives. */
  builtinFilter(model?: FileModel): BuiltinFilter {
    const directives = new Set<string>();
    if (model) {
      if (model.shadertoy.keyboard) directives.add('iKeyboard');
      for (const u of this.graph.closure(model.uri)) if (this.models.get(u)?.shadertoy.keyboard) directives.add('iKeyboard');
    }
    return { shadertoy: this.shadertoy, directives: model ? directives : undefined };
  }

  // ------------------------------------------------------------ indexing

  private isExcludedDir(name: string, dirUri: string, rootUri: string): boolean {
    if (name.startsWith('.') || this.exclude.has(name)) return true;
    if (this.fs.exists(normalizeUri(dirUri).replace(/\/?$/, '/') + IGNORE_MARKER)) return true;
    const rel = normalizeUri(dirUri).slice(normalizeUri(rootUri).replace(/\/?$/, '/').length);
    const relDecoded = decodeURIComponent(rel).toLowerCase();
    for (const entry of this.exclude) {
      if (!entry.includes('/') && !entry.includes('\\')) continue;
      const e = entry.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '').toLowerCase();
      if (relDecoded === e || relDecoded.endsWith('/' + e)) return true;
    }
    return false;
  }

  /** True when `uri` lies in a directory the indexer skips (exclude list, dot folders, marker file). */
  isExcludedUri(uri: string): boolean {
    uri = normalizeUri(uri);
    for (const root of this.roots) {
      if (!isUnder(root, uri)) continue;
      const parts = (relativePath(root, uri) ?? '').split('/');
      parts.pop();
      for (let i = 0; i < parts.length; i++) {
        if (this.isExcludedDir(parts[i], resolveUri(root, parts.slice(0, i + 1).join('/')), root)) return true;
      }
      return false;
    }
    return false;
  }

  private listRoots(): string[] {
    const uris: string[] = [];
    for (const root of this.roots) {
      uris.push(
        ...this.fs.listFiles(root, {
          acceptFile: isGlslPath,
          skipDir: (name, dirUri) => this.isExcludedDir(name, dirUri, root),
          maxFiles: this.maxFiles - uris.length,
        }),
      );
    }
    return uris.map(normalizeUri);
  }

  /**
   * After (re)indexing: drops models that are neither open nor listed any
   * more (deleted, excluded, removed folder) and re-reads files reached
   * through includes, so files outside the roots are refreshed too.
   */
  private finishIndex(listed: Set<string>) {
    for (const uri of [...this.models.keys()]) {
      if (!this.openUris.has(uri) && !listed.has(uri)) this.removeModel(uri, false);
    }
    this.reresolveAll();
    const queue = [...this.models.values()];
    while (queue.length) {
      const m = queue.pop()!;
      for (const inc of m.includes) {
        const u = inc.resolvedUri;
        if (!u || this.models.has(u) || this.missing.has(u)) continue;
        const loaded = this.loadFromDisk(u, false);
        if (loaded) queue.push(loaded);
      }
    }
  }

  /** Scans every root for GLSL files and parses them. Yields to the event loop between batches. */
  async indexWorkspace(onProgress?: (done: number, total: number) => void): Promise<IndexStats> {
    const t0 = Date.now();
    this.missing.clear();
    const uris = this.listRoots();
    for (let i = 0; i < uris.length; i++) {
      const uri = uris[i];
      if (!this.openUris.has(uri)) this.loadFromDisk(uri, false);
      if (i % 100 === 99) {
        onProgress?.(i + 1, uris.length);
        await new Promise((r) => setImmediate(r));
      }
    }
    this.finishIndex(new Set(uris));
    return { files: uris.length, ms: Date.now() - t0 };
  }

  /** Synchronous variant (tests, small workspaces). */
  indexWorkspaceSync(): IndexStats {
    const t0 = Date.now();
    this.missing.clear();
    const uris = this.listRoots();
    for (const u of uris) if (!this.openUris.has(u)) this.loadFromDisk(u, false);
    this.finishIndex(new Set(uris));
    return { files: uris.length, ms: Date.now() - t0 };
  }

  // ------------------------------------------------------------ document sync

  /** Open or change a buffer. Returns the new model. */
  openDocument(uri: string, text: string, version?: number): FileModel {
    uri = normalizeUri(uri);
    this.openUris.add(uri);
    return this.setModel(parse(text, uri, version), true);
  }

  /** Alias of openDocument for content changes. */
  updateDocument(uri: string, text: string, version?: number): FileModel {
    return this.openDocument(uri, text, version);
  }

  /** Buffer closed: fall back to the disk contents (or drop the file if it does not exist). */
  closeDocument(uri: string) {
    uri = normalizeUri(uri);
    this.openUris.delete(uri);
    if (!this.loadFromDisk(uri, true)) this.removeModel(uri);
  }

  isOpen(uri: string): boolean {
    return this.openUris.has(normalizeUri(uri));
  }

  /** A watched file changed/was created on disk. Ignored while the buffer is open. */
  fileChanged(uri: string) {
    uri = normalizeUri(uri);
    this.missing.delete(uri);
    if (this.openUris.has(uri) || !isGlslPath(uri)) return;
    if (this.models.has(uri)) {
      this.loadFromDisk(uri, true);
      return;
    }
    // New file. Inside an excluded folder it is not indexed, but includes may now resolve to it.
    if (!this.isExcludedUri(uri)) this.loadFromDisk(uri, false);
    const changed = this.reresolveAll();
    const model = this.models.get(uri);
    if (model) this.emit(uri, model, true, true);
    this.emitResolutionChanges(changed, uri);
  }

  fileCreated(uri: string) {
    this.fileChanged(uri);
  }

  /** A watched file or folder was deleted. A folder removes every model below it. */
  fileDeleted(uri: string) {
    uri = normalizeUri(uri);
    if (this.openUris.has(uri)) return;
    if (this.models.has(uri)) this.removeModel(uri);
    else {
      const prefix = uri.replace(/\/?$/, '/');
      for (const k of [...this.models.keys()]) if (k.startsWith(prefix) && !this.openUris.has(k)) this.removeModel(k);
    }
    for (const k of [...this.missing]) if (k === uri || k.startsWith(uri.replace(/\/?$/, '/'))) this.missing.delete(k);
    this.emitResolutionChanges(this.reresolveAll());
  }

  // ------------------------------------------------------------ model access

  /** Model for `uri`, loading it from disk on first use. */
  getModel(uri: string): FileModel | undefined {
    uri = normalizeUri(uri);
    const m = this.models.get(uri);
    if (m) return m;
    if (this.missing.has(uri)) return undefined;
    return this.loadFromDisk(uri, false);
  }

  /** Model if already loaded (never touches the disk). */
  peekModel(uri: string): FileModel | undefined {
    return this.models.get(normalizeUri(uri));
  }

  allModels(): IterableIterator<FileModel> {
    return this.models.values();
  }

  get size(): number {
    return this.models.size;
  }

  onDidChangeModel(listener: (e: ModelChangeEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private loadFromDisk(uri: string, notify: boolean): FileModel | undefined {
    const text = this.fs.readFile(uri);
    if (text === undefined) {
      this.missing.add(uri);
      return undefined;
    }
    return this.setModel(parse(text, uri), notify, true);
  }

  private setModel(model: FileModel, notify: boolean, fromDisk = false): FileModel {
    const uri = model.uri;
    const old = this.models.get(uri);
    if (old) this.removeGlobals(old);
    this.models.set(uri, model);
    if (this.fs.caseInsensitive) this.lowerKeys.set(uri.toLowerCase(), uri);
    this.missing.delete(uri);
    this.addGlobals(model);
    this.resolveIncludes(model);
    if (notify) this.emit(uri, model, fromDisk, !old || namesOf(old) !== namesOf(model));
    return model;
  }

  private removeModel(uri: string, notify = true) {
    const old = this.models.get(uri);
    if (!old) return;
    this.removeGlobals(old);
    this.models.delete(uri);
    if (this.lowerKeys.get(uri.toLowerCase()) === uri) this.lowerKeys.delete(uri.toLowerCase());
    const affected = [uri, ...this.graph.includers(uri)];
    this.graph.remove(uri);
    if (notify) this.emitRaw({ uri, affected, fromDisk: true, namesChanged: true });
  }

  private emit(uri: string, model: FileModel, fromDisk = false, namesChanged = false) {
    this.emitRaw({ uri, model, affected: [uri, ...this.graph.includers(uri)], fromDisk, namesChanged });
  }

  /** Change events for models whose include targets changed (they must be re-validated). */
  private emitResolutionChanges(changed: string[], skip?: string) {
    for (const u of changed) {
      if (u === skip) continue;
      const m = this.models.get(u);
      if (m) this.emit(u, m, true, false);
    }
  }

  private emitRaw(e: ModelChangeEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // listeners must not break document sync
      }
    }
  }

  private addGlobals(model: FileModel) {
    for (const s of model.symbols) {
      if (!s.name) continue;
      let list = this.byName.get(s.name);
      if (!list) this.byName.set(s.name, (list = []));
      list.push(s);
    }
  }

  private removeGlobals(model: FileModel) {
    for (const s of model.symbols) {
      const list = this.byName.get(s.name);
      if (!list) continue;
      const kept = list.filter((x) => x.uri !== model.uri);
      if (kept.length) this.byName.set(s.name, kept);
      else this.byName.delete(s.name);
    }
  }

  // ------------------------------------------------------------ includes

  private resolveIncludes(model: FileModel) {
    const targets: string[] = [];
    for (const inc of model.includes) {
      inc.resolvedUri = this.resolver.resolve(model.uri, inc.path);
      if (inc.resolvedUri && inc.resolvedUri !== model.uri) targets.push(inc.resolvedUri);
    }
    this.graph.setEdges(model.uri, targets);
  }

  /** Re-resolves every model's includes; returns the URIs whose include targets changed. */
  private reresolveAll(): string[] {
    const changed: string[] = [];
    for (const m of this.models.values()) {
      const before = m.includes.map((i) => i.resolvedUri ?? '').join('\n');
      this.resolveIncludes(m);
      if (m.includes.map((i) => i.resolvedUri ?? '').join('\n') !== before) changed.push(m.uri);
    }
    return changed;
  }

  /** Resolve an include path as written in `fromUri`. */
  resolveInclude(fromUri: string, path: string): string | undefined {
    return this.resolver.resolve(normalizeUri(fromUri), path);
  }

  /** Path text to write in `#include "..."` in `fromUri` to reach `targetUri`. */
  includePathFor(fromUri: string, targetUri: string): string {
    return this.resolver.includePathFor(normalizeUri(fromUri), normalizeUri(targetUri));
  }

  /** Every file reachable through includes (excluding `uri` itself), in include order. */
  transitiveIncludes(uri: string): string[] {
    uri = normalizeUri(uri);
    this.getModel(uri);
    return this.graph.closure(uri, (u) => {
      this.getModel(u);
    });
  }

  /** True if `targetUri` is `fromUri` or reachable through its includes. */
  isReachable(fromUri: string, targetUri: string): boolean {
    fromUri = normalizeUri(fromUri);
    targetUri = normalizeUri(targetUri);
    if (fromUri === targetUri) return true;
    this.transitiveIncludes(fromUri); // loads lazily and fills the cache
    return this.graph.closureSet(fromUri).has(targetUri);
  }

  directIncluders(uri: string): string[] {
    return this.graph.directIncluders(normalizeUri(uri));
  }

  /** Every file that includes `uri` directly or indirectly. */
  transitiveIncluders(uri: string): string[] {
    return this.graph.includers(normalizeUri(uri));
  }

  // ------------------------------------------------------------ global symbols

  /** Every top-level symbol named `name` in every indexed file. */
  lookupGlobal(name: string): GlobalSymbol[] {
    return this.byName.get(name) ?? [];
  }

  /** URIs of the files that declare a top-level `name` (for auto-include). */
  findDeclaringFiles(name: string): string[] {
    return [...new Set(this.lookupGlobal(name).filter((s) => !(s.kind === 'macro' && s.isIncludeGuard)).map((s) => s.uri))];
  }

  /** All global names (for workspace symbol search / completion). */
  globalNames(): IterableIterator<string> {
    return this.byName.keys();
  }

  /** All global symbols of every indexed file. */
  *allGlobalSymbols(): IterableIterator<GlobalSymbol> {
    for (const list of this.byName.values()) yield* list;
  }

  // ------------------------------------------------------------ paths for display

  /** Path of `uri` relative to the workspace root containing it (forward slashes), else the file system path. */
  displayPath(uri: string): string {
    for (const root of this.roots) {
      if (isUnder(root, uri)) return relativePath(root, uri) ?? uri;
    }
    try {
      return uriToFsPath(uri).replace(/\\/g, '/');
    } catch {
      return uri;
    }
  }

  /** Directory of a document URI. */
  dirname(uri: string): string {
    return dirnameUri(uri);
  }

  // ------------------------------------------------------------ resolution (see resolve.ts)

  /** Symbols visible at `position` in `uri`: scope-aware locals, this file, transitive includes. */
  visibleSymbols(uri: string, position: Position): resolve.VisibleSymbols {
    return resolve.visibleSymbols(this, normalizeUri(uri), position);
  }

  /** What the identifier (or #include path) at `position` refers to. */
  resolveSymbolAt(uri: string, position: Position): resolve.Resolution | undefined {
    return resolve.resolveSymbolAt(this, normalizeUri(uri), position);
  }

  /** Resolution of occurrence `index` in `model`. */
  resolveOccurrence(model: FileModel, index: number): resolve.Resolution | undefined {
    return resolve.resolveOccurrence(this, model, index);
  }

  /** All references to the symbol at `position` across the workspace. */
  findReferences(uri: string, position: Position, includeDeclaration = true): resolve.ReferenceLocation[] {
    return resolve.findReferences(this, normalizeUri(uri), position, includeDeclaration);
  }
}

/** Sorted top-level names of a model (to detect declaration changes). */
function namesOf(model: FileModel): string {
  return [...new Set(model.symbols.map((s) => s.name))].sort().join(',');
}
