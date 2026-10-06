// Navigation: definition, declaration, typeDefinition, references, rename,
// documentHighlight, documentSymbol, workspaceSymbol, documentLink.
// Handler logic lives in exported pure functions taking a Workspace.

import {
  DocumentHighlightKind,
  SymbolKind as LspSymbolKind,
  type DocumentHighlight,
  type DocumentLink,
  type DocumentSymbol,
  type Location,
  type Range as LspRange,
  type SymbolInformation,
  type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { ErrorCodes, ResponseError } from 'vscode-languageserver/node';
import type { ServerContext } from '../context';
import { inferArgType, typeScore } from './signatureHelp';
import {
  dirnameUri,
  findStructType,
  formatFunction,
  formatSymbol,
  fsPathToUri,
  invalidIdentifierReason,
  isUnder,
  normalizeUri,
  resolveUri,
  symbolType,
  type CallSite,
  type FileModel,
  type FieldSymbol,
  type FunctionSymbol,
  type GlobalSymbol,
  type GlslSymbol,
  type Position,
  type Workspace,
} from '../core';

const loc = (s: GlslSymbol): Location => ({ uri: s.uri, range: s.nameRange });

function zero(): LspRange {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

function dedupe(locs: Location[]): Location[] {
  const seen = new Set<string>();
  return locs.filter((l) => {
    const k = `${l.uri}:${l.range.start.line}:${l.range.start.character}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- definition

function pickFunctions(
  ws: Workspace,
  symbols: GlslSymbol[],
  primary: GlslSymbol,
  preferPrototype: boolean,
  call: { model: FileModel; site: CallSite } | undefined,
): GlslSymbol[] {
  const fns = symbols.filter((s): s is FunctionSymbol => s.kind === 'function');
  if (!fns.length) return symbols;
  let pool = fns;
  if (call && primary.kind === 'function') {
    const n = primary.params.length;
    const matching = fns.filter((f) => f.params.length === n);
    if (matching.length) pool = matching;
    // Same arity: rank by argument types like signature help (keep ties / unknowns).
    if (pool.length > 1) {
      const { model, site } = call;
      const args = site.args.map((r) => inferArgType(ws, model, { start: model.lines.offsetAt(r.start), end: model.lines.offsetAt(r.end) }));
      const score = (f: FunctionSymbol) => f.params.reduce((sum, p, i) => sum + typeScore(p.type.name + (p.type.array ?? ''), args[i]), 0);
      const best = Math.max(...pool.map(score));
      pool = pool.filter((f) => score(f) === best);
    }
  }
  const wanted = pool.filter((f) => f.isPrototype === preferPrototype);
  return wanted.length ? wanted : pool;
}

function targetsOf(ws: Workspace, uri: string, position: Position, preferPrototype: boolean): Location[] {
  const res = ws.resolveSymbolAt(uri, position);
  if (!res) return [];
  if (res.kind === 'include') return res.targetUri ? [{ uri: res.targetUri, range: zero() }] : [];
  if (res.kind !== 'symbol') return [];
  let pool = res.symbols;
  if (preferPrototype) {
    // Resolution hides prototypes that have a definition; bring them back.
    const extra = ws.lookupGlobal(res.name).filter(
      (s): s is FunctionSymbol => s.kind === 'function' && s.isPrototype && pool.some((p) => p.kind === 'function' && p.uri === s.uri),
    );
    pool = [...pool, ...extra.filter((e) => !pool.includes(e))];
  }
  const model = ws.getModel(uri);
  const syms = pickFunctions(ws, pool, res.primary, preferPrototype, res.call && model ? { model, site: res.call } : undefined);
  return dedupe(syms.map(loc));
}

export function computeDefinition(ws: Workspace, uri: string, position: Position): Location[] {
  return targetsOf(ws, uri, position, false);
}

export function computeDeclaration(ws: Workspace, uri: string, position: Position): Location[] {
  return targetsOf(ws, uri, position, true);
}

export function computeTypeDefinition(ws: Workspace, uri: string, position: Position): Location[] {
  const res = ws.resolveSymbolAt(uri, position);
  if (!res || res.kind !== 'symbol') return [];
  const t = symbolType(res.primary);
  if (!t) return [];
  const model = ws.getModel(res.primary.uri);
  if (!model) return [];
  const st = findStructType(ws, model, t.name, res.primary.nameOffset);
  return st ? [loc(st)] : [];
}

// ---------------------------------------------------------------- references / highlight

export function computeReferences(ws: Workspace, uri: string, position: Position, includeDeclaration: boolean): Location[] {
  return ws.findReferences(uri, position, includeDeclaration).map((r) => ({ uri: r.uri, range: r.range }));
}

export function computeHighlights(ws: Workspace, uri: string, position: Position): DocumentHighlight[] {
  const nuri = normalizeUri(uri);
  return ws
    .findReferences(uri, position, true)
    .filter((r) => normalizeUri(r.uri) === nuri)
    .map((r) => ({ range: r.range, kind: r.isDeclaration ? DocumentHighlightKind.Write : DocumentHighlightKind.Read }));
}

// ---------------------------------------------------------------- rename

export interface RenameOptions {
  /**
   * Folders whose files are never edited by a rename (glslLsp.rename.readOnlyPaths):
   * a bare name matches that folder anywhere, an entry with `/` a path
   * relative to a workspace folder. Files outside every workspace folder are
   * read-only too.
   */
  readOnlyPaths?: string[];
}

export const DEFAULT_READ_ONLY_PATHS = ['lygia'];

/** True when `uri` must not be edited by a rename. */
export function isReadOnlyForRename(ws: Workspace, uri: string, readOnlyPaths: string[] = DEFAULT_READ_ONLY_PATHS): boolean {
  const roots = ws.workspaceRoots;
  // Outside every workspace folder (an include path, a library elsewhere): read-only, unless the user has it open.
  if (roots.length && !roots.some((r) => isUnder(r, uri)) && !ws.isOpen(uri)) return true;
  const rel = ws.displayPath(uri).toLowerCase();
  const segments = rel.split('/');
  segments.pop();
  for (const entry of readOnlyPaths) {
    const e = entry.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '').toLowerCase();
    if (!e) continue;
    if (!e.includes('/')) {
      if (segments.includes(e)) return true;
    } else if (rel.startsWith(e + '/') || rel.includes('/' + e + '/')) return true;
  }
  return false;
}

/** Why the symbol at `position` cannot be renamed, or undefined. */
export function renameRefusal(ws: Workspace, uri: string, position: Position, options: RenameOptions = {}): string | undefined {
  const res = ws.resolveSymbolAt(uri, position);
  if (!res) return 'Nothing to rename here.';
  if (res.kind === 'builtin') return `'${res.name}' is a GLSL builtin and cannot be renamed.`;
  if (res.kind === 'include') return 'Include paths cannot be renamed.';
  if (res.kind === 'swizzle') return `'${res.name}' is a swizzle and cannot be renamed.`;
  if (res.primary.kind === 'macro' && res.primary.isIncludeGuard) return `'${res.name}' is an include guard.`;
  const readOnly = options.readOnlyPaths ?? DEFAULT_READ_ONLY_PATHS;
  const decls = new Set(res.symbols.map((s) => s.uri));
  for (const r of ws.findReferences(uri, position, true)) if (r.isDeclaration) decls.add(normalizeUri(r.uri));
  for (const d of decls) {
    if (isReadOnlyForRename(ws, d, readOnly)) return `'${res.name}' is declared in ${ws.displayPath(d)}, which is read-only for renames (glslLsp.rename.readOnlyPaths).`;
  }
  return undefined;
}

export function computePrepareRename(ws: Workspace, uri: string, position: Position, options: RenameOptions = {}): { range: LspRange; placeholder: string } | { error: string } | null {
  const model = ws.getModel(uri);
  if (!model) return null;
  const res = ws.resolveSymbolAt(uri, position);
  if (!res) return null;
  const refusal = renameRefusal(ws, uri, position, options);
  if (refusal) return { error: refusal };
  const off = model.lines.offsetAt(position);
  const occ = model.occurrences.find((o) => model.lines.offsetAt(o.range.start) <= off && off <= model.lines.offsetAt(o.range.end));
  if (!occ) return null;
  return { range: occ.range, placeholder: occ.name };
}

/** Why `newName` cannot be used for the symbol at `position`, or undefined. */
export function newNameRefusal(ws: Workspace, newName: string): string | undefined {
  const reason = invalidIdentifierReason(newName);
  if (reason) return `Cannot rename: ${reason}.`;
  if (ws.builtins.get(newName)) return `Cannot rename: '${newName}' is a GLSL builtin.`;
  return undefined;
}

export function computeRename(ws: Workspace, uri: string, position: Position, newName: string, options: RenameOptions = {}): WorkspaceEdit | null {
  if (newNameRefusal(ws, newName)) return null;
  const prep = computePrepareRename(ws, uri, position, options);
  if (!prep || 'error' in prep) return null;
  const refs = ws.findReferences(uri, position, true);
  if (!refs.length) return null;
  const changes: Record<string, { range: LspRange; newText: string }[]> = {};
  const seen = new Set<string>();
  for (const r of refs) {
    const k = `${r.uri}:${r.range.start.line}:${r.range.start.character}`;
    if (seen.has(k)) continue;
    seen.add(k);
    (changes[r.uri] ??= []).push({ range: r.range, newText: newName });
  }
  return { changes };
}

// ---------------------------------------------------------------- symbols

function kindOf(s: GlslSymbol): LspSymbolKind {
  switch (s.kind) {
    case 'function':
      return LspSymbolKind.Function;
    case 'struct':
      return LspSymbolKind.Struct;
    case 'field':
      return LspSymbolKind.Field;
    case 'block':
      return LspSymbolKind.Interface;
    case 'macro':
      return s.params ? LspSymbolKind.Function : LspSymbolKind.Constant;
    case 'parameter':
      return LspSymbolKind.Variable;
    case 'variable':
      if (s.iUniform || s.iChannel) return LspSymbolKind.Property;
      if (s.qualifiers.includes('const')) return LspSymbolKind.Constant;
      return LspSymbolKind.Variable;
  }
}

function detailOf(s: GlslSymbol): string {
  try {
    if (s.kind === 'function') return formatFunction(s);
    if (s.kind === 'macro') return s.params ? `#define ${s.name}(${s.params.join(', ')})` : '#define';
    if (s.kind === 'struct') return 'struct';
    if (s.kind === 'block') return `${s.qualifiers.join(' ')} block`;
    return formatSymbol(s);
  } catch {
    return '';
  }
}

function inside(outer: LspRange, inner: LspRange): boolean {
  const le = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  return le(outer.start, inner.start) && le(inner.end, outer.end);
}

function toDocSymbol(s: GlslSymbol): DocumentSymbol {
  const ds: DocumentSymbol = {
    name: s.name || '(unnamed)',
    detail: detailOf(s),
    kind: kindOf(s),
    range: inside(s.range, s.nameRange) ? s.range : s.nameRange,
    selectionRange: s.nameRange,
  };
  if (s.kind === 'struct' || s.kind === 'block') ds.children = s.fields.map((f: FieldSymbol) => toDocSymbol(f));
  return ds;
}

export function computeDocumentSymbols(ws: Workspace, uri: string): DocumentSymbol[] {
  const model = ws.getModel(uri);
  if (!model) return [];
  return (model.symbols as GlobalSymbol[])
    .filter((s) => !(s.kind === 'macro' && s.isIncludeGuard))
    .slice()
    .sort((a, b) => a.nameOffset - b.nameOffset)
    .map(toDocSymbol);
}

/** Fuzzy score; higher is better, -1 means no match. */
export function fuzzyScore(name: string, query: string): number {
  if (!query) return 0;
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 800 - n.length;
  const idx = n.indexOf(q);
  if (idx >= 0) return 600 - idx - n.length / 100;
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] === q[qi]) {
      score += prev === i - 1 ? 3 : 1;
      if (i === 0 || name[i] !== n[i]) score += 2;
      prev = i;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

const MAX_WORKSPACE_SYMBOLS = 200;

export function computeWorkspaceSymbols(ws: Workspace, query: string): SymbolInformation[] {
  const scored: { s: GlobalSymbol; score: number }[] = [];
  for (const s of ws.allGlobalSymbols()) {
    if (s.kind === 'macro' && s.isIncludeGuard) continue;
    const score = fuzzyScore(s.name, query);
    if (score >= 0) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length || a.s.name.localeCompare(b.s.name));
  const seen = new Set<string>();
  const out: SymbolInformation[] = [];
  for (const { s } of scored) {
    const key = `${s.uri}:${s.name}:${s.nameOffset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: s.name, kind: kindOf(s), location: loc(s), containerName: ws.displayPath(s.uri) });
    if (out.length >= MAX_WORKSPACE_SYMBOLS) break;
  }
  return out;
}

// ---------------------------------------------------------------- links

function channelTarget(fromUri: string, source: string): string | undefined {
  try {
    if (source.startsWith('file://')) {
      let p = decodeURIComponent(source.slice('file://'.length));
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')) return normalizeUri(fsPathToUri(p));
      return normalizeUri(resolveUri(dirnameUri(fromUri), p));
    }
    if (/^[a-z]+:\/\//i.test(source) || /^(buffer|keyboard|self|cubemap)/i.test(source)) return undefined;
    return normalizeUri(resolveUri(dirnameUri(fromUri), source));
  } catch {
    return undefined;
  }
}

const CUBE_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz', 'e', 'w', 'u', 'd', 'n', 's'];

export function computeDocumentLinks(ws: Workspace, uri: string): DocumentLink[] {
  const model = ws.getModel(uri);
  if (!model) return [];
  const links: DocumentLink[] = [];
  for (const inc of model.includes) {
    if (!inc.resolvedUri) continue;
    links.push({ range: inc.pathRange, target: inc.resolvedUri, tooltip: ws.displayPath(inc.resolvedUri) });
  }
  for (const ch of model.shadertoy.channels) {
    const start = model.lines.offsetAt(ch.range.start);
    const text = model.text.slice(start, model.lines.offsetAt(ch.range.end));
    const m = /"([^"]*)"/.exec(text);
    if (!m) continue;
    let target = channelTarget(model.uri, m[1]);
    if (m[1].includes('{}')) {
      // shader-toy cubemap pattern `sky_{}.png`: link the first face that exists.
      target = CUBE_FACES.map((f) => channelTarget(model.uri, m[1].replace('{}', f))).find((u) => !!u && ws.fs.exists(u));
    }
    if (!target) continue;
    const s = start + m.index + 1;
    links.push({
      range: { start: model.lines.positionAt(s), end: model.lines.positionAt(s + m[1].length) },
      target,
      tooltip: ws.displayPath(target),
    });
  }
  return links;
}

// ---------------------------------------------------------------- registration

export function register(ctx: ServerContext): void {
  const c = ctx.connection;
  const ws = ctx.workspace;
  const guard =
    <P extends unknown[], R>(name: string, fallback: R, fn: (...a: P) => R) =>
    (...a: P): R => {
      try {
        return fn(...a);
      } catch (err) {
        if (err instanceof ResponseError) throw err; // shown to the user (e.g. why a rename is refused)
        ctx.log.error(`${name} failed: ${(err as Error).stack ?? err}`);
        return fallback;
      }
    };
  c.onDefinition(guard('definition', null, (p) => computeDefinition(ws, p.textDocument.uri, p.position)));
  c.onDeclaration(guard('declaration', null, (p) => computeDeclaration(ws, p.textDocument.uri, p.position)));
  c.onTypeDefinition(guard('typeDefinition', null, (p) => computeTypeDefinition(ws, p.textDocument.uri, p.position)));
  c.onReferences(guard('references', [], (p) => computeReferences(ws, p.textDocument.uri, p.position, p.context.includeDeclaration)));
  const renameOptions = (): RenameOptions => ({ readOnlyPaths: ctx.settings.get().rename.readOnlyPaths });
  c.onPrepareRename(
    guard('prepareRename', null, (p) => {
      const r = computePrepareRename(ws, p.textDocument.uri, p.position, renameOptions());
      if (r && 'error' in r) throw new ResponseError(ErrorCodes.InvalidRequest, r.error);
      return r;
    }),
  );
  c.onRenameRequest(
    guard('rename', null, (p) => {
      const why = newNameRefusal(ws, p.newName) ?? renameRefusal(ws, p.textDocument.uri, p.position, renameOptions());
      if (why) throw new ResponseError(ErrorCodes.InvalidRequest, why);
      return computeRename(ws, p.textDocument.uri, p.position, p.newName, renameOptions());
    }),
  );
  c.onDocumentHighlight(guard('documentHighlight', [], (p) => computeHighlights(ws, p.textDocument.uri, p.position)));
  c.onDocumentSymbol(guard('documentSymbol', [], (p) => computeDocumentSymbols(ws, p.textDocument.uri)));
  c.onWorkspaceSymbol(guard('workspaceSymbol', [], (p) => computeWorkspaceSymbols(ws, p.query)));
  c.onDocumentLinks(guard('documentLink', [], (p) => computeDocumentLinks(ws, p.textDocument.uri)));
}
