// Code actions (quick fixes):
//  - "Add #include "..."" for an identifier that is not visible through the
//    file's includes but is declared somewhere in the workspace. Works from
//    'undeclared-identifier' diagnostics (data.name) and from the bare cursor.
//    One action per candidate file (see autoInclude.ts), best one preferred.
//  - "Change to "..."" for an unresolved #include path: files with the same
//    file name elsewhere in the workspace.
//  - "Remove unused #include "..."" when the cursor is on an include none of
//    whose (exclusively provided) symbols is referenced by this file, by the
//    files of its other includes or by files including this one.
//    Conservative: name-based.

import {
  CodeActionKind,
  type CodeAction,
  type CodeActionParams,
  type Diagnostic,
  type Range,
  type TextEdit,
} from 'vscode-languageserver/node';
import type { ServerContext } from '../context';
import {
  basenameUri,
  normalizeUri,
  occurrenceIndexAt,
  rangeContains,
  type FileModel,
  type IncludeDirective,
  type Workspace,
} from '../core';
import { IncludeContext } from './autoInclude';

export const UNDECLARED_IDENTIFIER = 'undeclared-identifier';
const MAX_ACTIONS_PER_NAME = 5;

export interface CodeActionEnv {
  workspace: Workspace;
}

interface NameAtRange {
  name: string;
  diagnostic?: Diagnostic;
}

/** Identifier occurrence touching `range.start`, if it is unresolved or only resolves workspace-wide. */
function unresolvedNameAt(ws: Workspace, model: FileModel, range: Range): string | undefined {
  const offsets = [model.lines.offsetAt(range.start)];
  const endOff = model.lines.offsetAt(range.end);
  if (endOff !== offsets[0]) offsets.push(endOff);
  for (const off of offsets) {
    const idx = occurrenceIndexAt(model, off);
    if (idx < 0) continue;
    const occ = model.occurrences[idx];
    if (occ.role === 'declaration' || occ.role === 'member') continue;
    const res = ws.resolveOccurrence(model, idx);
    if (!res || (res.kind === 'symbol' && res.fromWorkspace)) return occ.name;
  }
  return undefined;
}

function diagnosticName(model: FileModel, d: Diagnostic): string | undefined {
  const data = d.data as { name?: unknown } | undefined;
  if (data && typeof data.name === 'string' && data.name) return data.name;
  const text = model.text.slice(model.lines.offsetAt(d.range.start), model.lines.offsetAt(d.range.end));
  return /^[A-Za-z_]\w*$/.test(text) ? text : undefined;
}

export function addIncludeActions(ws: Workspace, model: FileModel, params: CodeActionParams): CodeAction[] {
  const names: NameAtRange[] = [];
  for (const d of params.context.diagnostics) {
    if (d.code !== UNDECLARED_IDENTIFIER) continue;
    const name = diagnosticName(model, d);
    if (name) names.push({ name, diagnostic: d });
  }
  const cursorName = unresolvedNameAt(ws, model, params.range);
  if (cursorName && !names.some((n) => n.name === cursorName)) names.push({ name: cursorName });
  if (!names.length) return [];

  const ctx = new IncludeContext(ws, model);
  const actions: CodeAction[] = [];
  const done = new Set<string>();
  for (const { name, diagnostic } of names) {
    if (ws.builtins.get(name, ws.builtinFilter(model))) continue;
    const candidates = ctx.candidatesFor(name).slice(0, MAX_ACTIONS_PER_NAME);
    candidates.forEach((c, i) => {
      const key = name + '|' + c.targetUri;
      if (done.has(key)) return;
      done.add(key);
      const edit = ctx.includeEdit(c.path);
      if (!edit) return;
      actions.push({
        title: `Add #include "${c.path}"` + (c.via ? ` (provides ${name})` : ''),
        kind: CodeActionKind.QuickFix,
        isPreferred: i === 0,
        diagnostics: diagnostic ? [diagnostic] : undefined,
        edit: { changes: { [params.textDocument.uri]: [edit] } },
      });
    });
  }
  return actions;
}

/** Quick fixes for an unresolved `#include` under the cursor: same file name elsewhere. */
export function fixIncludePathActions(ws: Workspace, model: FileModel, params: CodeActionParams): CodeAction[] {
  const inc = model.includes.find((i) => !i.resolvedUri && rangeContains(i.range, params.range.start));
  if (!inc) return [];
  const base = (inc.path.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase();
  if (!base) return [];
  const self = normalizeUri(model.uri);
  const hits: string[] = [];
  for (const m of ws.allModels()) {
    if (m.uri !== self && basenameUri(m.uri).toLowerCase() === base) hits.push(ws.includePathFor(self, m.uri));
  }
  hits.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  const diagnostics = params.context.diagnostics.filter((d) => rangeContains(inc.range, d.range.start));
  return hits.slice(0, MAX_ACTIONS_PER_NAME).map((path, i) => ({
    title: inc.angle ? `Change to <${path}>` : `Change to "${path}"`,
    kind: CodeActionKind.QuickFix,
    isPreferred: i === 0 && hits.length === 1,
    diagnostics: diagnostics.length ? diagnostics : undefined,
    edit: { changes: { [params.textDocument.uri]: [{ range: inc.pathRange, newText: path }] } },
  }));
}

/**
 * Whether `inc` can be removed: 'redundant' when everything it brings in is
 * also reachable through the includes before it (or through later ones, when
 * nothing uses those names before them), 'unused' when nothing that only it
 * brings in is referenced by `model`, by the files of its other includes or by
 * files including `model`. Name-based, so it errs on the side of "used".
 */
export function includeRemoval(ws: Workspace, model: FileModel, inc: IncludeDirective): 'unused' | 'redundant' | undefined {
  const target = inc.resolvedUri;
  if (!target || target === model.uri) return undefined;
  const provided = new Set([target, ...ws.transitiveIncludes(target)]);
  const incStart = model.lines.offsetAt(inc.range.start);
  const earlier = new Set<string>();
  const others = new Set<string>();
  /** File -> offset of the first later include that provides it. */
  const laterAt = new Map<string, number>();
  /** Later includes with their offsets and transitive closures. */
  const later: { at: number; files: string[] }[] = [];
  for (const other of model.includes) {
    if (other === inc || !other.resolvedUri) continue;
    const at = model.lines.offsetAt(other.range.start);
    const files = [other.resolvedUri, ...ws.transitiveIncludes(other.resolvedUri)];
    if (at > incStart) later.push({ at, files });
    for (const u of files) {
      others.add(u);
      if (at < incStart) earlier.add(u);
      else if (!laterAt.has(u)) laterAt.set(u, at);
    }
  }
  const notEarlier = [...provided].filter((u) => !earlier.has(u) && u !== model.uri);
  if (!notEarlier.length) return 'redundant';
  // Names that would disappear, with the offset from which a later include provides them again.
  const limitOf = new Map<string, number>();
  for (const u of notEarlier) {
    const m = ws.getModel(u);
    if (!m) return undefined; // unknown contents: assume used
    const limit = laterAt.get(u) ?? Infinity;
    const add = (name: string) => {
      if (name) limitOf.set(name, Math.max(limitOf.get(name) ?? -1, limit));
    };
    for (const s of m.symbols) add(s.name);
    for (const b of m.blocks) for (const f of b.fields) add(f.name);
  }
  const isUse = (o: FileModel['occurrences'][number]) => o.role !== 'declaration' && o.role !== 'member';
  if (model.occurrences.some((o) => isUse(o) && o.start < (limitOf.get(o.name) ?? -Infinity))) return undefined;
  // Files pulled in by includes between this one and a name's later provider see the name
  // only through this include: their uses count too (exclusive names are checked below).
  for (const { at, files } of later) {
    const needed = [...limitOf].filter(([, limit]) => limit !== Infinity && at < limit).map(([n]) => n);
    if (!needed.length) continue;
    const names = new Set(needed);
    for (const u of files) {
      if (earlier.has(u)) continue; // already inlined before this include: unaffected
      const m = ws.getModel(u);
      if (m && m.occurrences.some((o) => isUse(o) && names.has(o.name))) return undefined;
    }
  }
  const exclusive = new Set([...limitOf].filter(([, limit]) => limit === Infinity).map(([n]) => n));
  if (!exclusive.size) return 'redundant';
  // Files of the other includes may rely on it, and so may files including this one (a library re-exporting it).
  const uses = (m: FileModel) => m.occurrences.some((o) => isUse(o) && exclusive.has(o.name));
  for (const u of [...others, ...ws.transitiveIncluders(model.uri)]) {
    const m = ws.getModel(u);
    if (m && uses(m)) return undefined;
  }
  return 'unused';
}

export function isIncludeUnused(ws: Workspace, model: FileModel, inc: IncludeDirective): boolean {
  return includeRemoval(ws, model, inc) !== undefined;
}

export function removeUnusedIncludeActions(ws: Workspace, model: FileModel, params: CodeActionParams): CodeAction[] {
  const inc = model.includes.find((i) => i.resolvedUri && rangeContains(i.range, params.range.start));
  if (!inc) return [];
  const removal = includeRemoval(ws, model, inc);
  if (!removal) return [];
  const line = inc.range.start.line;
  const nextLine = line + 1 < model.lines.lineCount ? { line: line + 1, character: 0 } : { line, character: model.lines.lineText(line).length };
  const start = line + 1 < model.lines.lineCount || line === 0 ? { line, character: 0 } : { line: line - 1, character: model.lines.lineText(line - 1).length };
  const edit: TextEdit = { range: { start, end: nextLine }, newText: '' };
  return [
    {
      title: removal === 'unused' ? `Remove unused #include "${inc.path}"` : `Remove redundant #include "${inc.path}" (included through another #include)`,
      kind: CodeActionKind.QuickFix,
      edit: { changes: { [params.textDocument.uri]: [edit] } },
    },
  ];
}

/** Pure code action computation (used by tests). */
export function computeCodeActions(env: CodeActionEnv, params: CodeActionParams): CodeAction[] {
  const ws = env.workspace;
  const model = ws.getModel(params.textDocument.uri);
  if (!model) return [];
  const only = params.context.only;
  if (only && !only.some((k) => CodeActionKind.QuickFix.startsWith(k) || k.startsWith(CodeActionKind.QuickFix))) return [];
  return [...addIncludeActions(ws, model, params), ...fixIncludePathActions(ws, model, params), ...removeUnusedIncludeActions(ws, model, params)];
}

export function register(ctx: ServerContext): void {
  ctx.connection.onCodeAction((params) => {
    try {
      return computeCodeActions({ workspace: ctx.workspace }, params);
    } catch (err) {
      ctx.log.error(`code actions failed: ${(err as Error).stack ?? err}`);
      return [];
    }
  });
}
