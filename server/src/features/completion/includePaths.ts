// `#include "` path completion: folders then files of the directory typed so
// far, relative to the including file (falling back to include paths and
// workspace roots), built from the indexed files so it is instant even for
// LYGIA's ~1000 files.

import { CompletionItemKind, type CompletionItem, type Range } from 'vscode-languageserver/node';
import { dirnameUri, isUnder, normalizeUri, resolveUri, type FileModel } from '../../core';
import { TRIGGER_SUGGEST } from './items';
import type { CompletionEnv } from './types';

export interface IncludePathRequest {
  /** Path text typed between the quote and the cursor. */
  typed: string;
  /** Offset of the start of `typed`. */
  typedStart: number;
  quote: '"' | '<';
  hasClosingQuote: boolean;
  /** Line text after the cursor (to replace the rest of the segment / path). */
  after?: string;
}

interface DirEntries {
  folders: Set<string>;
  files: Map<string, string>; // name -> uri
}

/** Immediate children (from indexed files) of directory URI `dir`. */
function listIndexed(env: CompletionEnv, dir: string, exclude: string): DirEntries {
  const prefix = dir.endsWith('/') ? dir : dir + '/';
  const out: DirEntries = { folders: new Set(), files: new Map() };
  for (const m of env.workspace.allModels()) {
    const u = m.uri;
    if (!u.startsWith(prefix) || u === exclude) continue;
    const rest = u.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) out.folders.add(safeDecode(rest.slice(0, slash)));
    else out.files.set(safeDecode(rest), u);
  }
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function includePathCompletions(env: CompletionEnv, model: FileModel, req: IncludePathRequest): CompletionItem[] {
  const typed = req.typed.replace(/\\/g, '/');
  const slash = typed.lastIndexOf('/');
  const dirPart = slash >= 0 ? typed.slice(0, slash + 1) : '';
  const segment = typed.slice(slash + 1);
  const segStart = req.typedStart + req.typed.length - segment.length;
  const cursor = req.typedStart + req.typed.length;
  const close = req.quote === '"' ? '"' : '>';
  // Completing in the middle of an existing path: a folder replaces the rest
  // of its segment, a file replaces everything up to the closing quote.
  const after = req.after ?? '';
  const segEndLen = after.search(/[\/\\"<>]|$/);
  const nextIsSlash = after.charAt(segEndLen) === '/' || after.charAt(segEndLen) === '\\';
  const closeAt = after.indexOf(close);
  const range: Range = model.lines.range(segStart, cursor + segEndLen);
  const fileRange: Range = model.lines.range(segStart, cursor + (closeAt >= 0 ? closeAt : segEndLen));
  const self = normalizeUri(model.uri);
  const baseDir = dirnameUri(self);
  const relDir = dirPart ? resolveUri(baseDir, dirPart) : baseDir;

  let entries = listIndexed(env, relDir, self);
  if (!entries.folders.size && !entries.files.size && dirPart && !dirPart.startsWith('.')) {
    // `#include "lygia/..."` from a subfolder: resolved through include paths / workspace roots.
    for (const dir of env.workspace.resolver.searchDirs()) {
      const e = listIndexed(env, resolveUri(dir, dirPart), self);
      for (const f of e.folders) entries.folders.add(f);
      for (const [n, u] of e.files) if (!entries.files.has(n)) entries.files.set(n, u);
    }
  }

  const items: CompletionItem[] = [];
  // `../` while the directory lies below a workspace root (there is more to browse above).
  if (/^(\.\.\/)*$/.test(dirPart) && env.workspace.workspaceRoots.some((r) => r !== relDir && isUnder(r, relDir))) {
    items.push({ label: '../', kind: CompletionItemKind.Folder, sortText: '0_', textEdit: { range, newText: nextIsSlash ? '..' : '../' }, command: TRIGGER_SUGGEST });
  }
  for (const f of [...entries.folders].sort()) {
    items.push({
      label: f + '/',
      kind: CompletionItemKind.Folder,
      sortText: '1_' + f,
      filterText: f,
      textEdit: { range, newText: nextIsSlash ? f : f + '/' },
      command: TRIGGER_SUGGEST,
    });
  }
  for (const [name, uri] of [...entries.files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const model = env.workspace.peekModel(uri);
    const isShader = !!model && (model.shadertoy.hasMainImage || model.functions.some((fn) => fn.name === 'main'));
    const fns = model ? [...new Set(model.functions.map((fn) => fn.name))] : [];
    items.push({
      label: name,
      kind: CompletionItemKind.File,
      detail: fns.length ? fns.slice(0, 6).join(', ') + (fns.length > 6 ? ', …' : '') : undefined,
      sortText: (isShader ? '3_' : '2_') + name,
      textEdit: { range: fileRange, newText: name + (req.hasClosingQuote ? '' : close) },
    });
  }
  return items;
}
