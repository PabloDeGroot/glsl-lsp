// Semantic tokens: classifies every identifier occurrence using the resolved
// symbol (function / parameter / variable / property / struct / macro / ...),
// with `declaration`, `definition`, `readonly`, `static` and `defaultLibrary`
// modifiers. Keywords, basic types and literals are left to the TextMate
// grammar. Full and range requests share one pure core: `computeSemanticTokens`.

import type { SemanticTokens, SemanticTokensParams, SemanticTokensRangeParams } from 'vscode-languageserver/node';
import type { ServerContext } from '../context';
import { onDependentsChanged } from './refresh';
import {
  modifierMask,
  tokenTypeIndex,
  type FileModel,
  type GlslSymbol,
  type Occurrence,
  type Range,
  type Resolution,
  type SemanticTokenModifier,
  type SemanticTokenType,
  type Workspace,
} from '../core';

interface Classified {
  type: SemanticTokenType;
  mods: SemanticTokenModifier[];
}

function classifySymbol(sym: GlslSymbol, occ: Occurrence): Classified {
  const mods: SemanticTokenModifier[] = [];
  const isDecl = occ.role === 'declaration' && occ.symbol === sym;
  if (isDecl) mods.push('declaration');
  switch (sym.kind) {
    case 'function':
      if (isDecl && !sym.isPrototype) mods.push('definition');
      return { type: 'function', mods };
    case 'parameter':
      if (sym.qualifiers.includes('const')) mods.push('readonly');
      return { type: 'parameter', mods };
    case 'variable':
      if (sym.storage === 'global') mods.push('static');
      if (sym.qualifiers.includes('const') || sym.qualifiers.includes('uniform') || sym.origin === 'iUniform' || sym.origin === 'iChannel') {
        mods.push('readonly');
      }
      return { type: 'variable', mods };
    case 'struct':
      if (isDecl) mods.push('definition');
      return { type: 'struct', mods };
    case 'block':
      return { type: occ.name === sym.instanceName ? 'variable' : 'struct', mods };
    case 'field':
      return { type: 'property', mods };
    case 'macro':
      return { type: 'macro', mods };
  }
}

function classifyResolution(res: Resolution, occ: Occurrence): Classified | undefined {
  switch (res.kind) {
    case 'symbol':
      return classifySymbol(occ.role === 'declaration' && occ.symbol ? occ.symbol : res.primary, occ);
    case 'swizzle':
      return { type: 'property', mods: [] };
    case 'include':
      return undefined;
    case 'builtin': {
      const e = res.entry;
      switch (e.kind) {
        case 'function':
          return { type: 'function', mods: ['defaultLibrary'] };
        case 'variable': {
          if (e.name.startsWith('Key_') || e.value !== undefined) return { type: 'enumMember', mods: ['readonly', 'defaultLibrary'] };
          const mods: SemanticTokenModifier[] = ['defaultLibrary'];
          if (e.qualifiers?.some((q) => q === 'const' || q === 'uniform')) mods.push('readonly');
          return { type: 'variable', mods };
        }
        case 'type':
          return { type: 'type', mods: ['defaultLibrary'] };
        case 'macro':
          return { type: 'macro', mods: ['defaultLibrary'] };
        default:
          return undefined;
      }
    }
  }
}

/**
 * Encodes tokens (LSP relative format) for occurrences intersecting `range`
 * (whole file when omitted). Pure; used by tests with `makeWorkspace`.
 */
export function computeSemanticTokens(ws: Workspace, model: FileModel, range?: Range): SemanticTokens {
  const startOffset = range ? model.lines.offsetAt(range.start) : 0;
  const endOffset = range ? model.lines.offsetAt(range.end) : model.text.length;
  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;
  const occs = model.occurrences;
  // Occurrences are sorted by offset: binary-search the first one in range.
  let lo = 0;
  let hi = occs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (occs[mid].end <= startOffset) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < occs.length; i++) {
    const occ = occs[i];
    if (occ.start >= endOffset) break;
    let cls: Classified | undefined;
    try {
      const res = ws.resolveOccurrence(model, i);
      if (res) cls = classifyResolution(res, occ);
    } catch {
      cls = undefined;
    }
    if (!cls) continue;
    const line = occ.range.start.line;
    const char = occ.range.start.character;
    if (line < prevLine || (line === prevLine && char < prevChar)) continue; // defensive: keep order
    data.push(
      line - prevLine,
      line === prevLine ? char - prevChar : char,
      occ.end - occ.start,
      tokenTypeIndex(cls.type),
      modifierMask(...cls.mods),
    );
    prevLine = line;
    prevChar = char;
  }
  return { data };
}

export function register(ctx: ServerContext): void {
  const run = (uri: string, range?: Range): SemanticTokens => {
    try {
      const model = ctx.getModel(uri);
      if (!model) return { data: [] };
      return computeSemanticTokens(ctx.workspace, model, range);
    } catch (err) {
      ctx.log.error(`semanticTokens failed: ${(err as Error).stack ?? err}`);
      return { data: [] };
    }
  };
  // Colors depend on included files (functions, macros, uniforms declared there).
  onDependentsChanged(ctx, () => ctx.clientCapabilities.semanticTokensRefresh, () => ctx.connection.languages.semanticTokens.refresh(), 'semanticTokens');
  ctx.connection.languages.semanticTokens.on((p: SemanticTokensParams) => run(p.textDocument.uri));
  ctx.connection.languages.semanticTokens.onRange((p: SemanticTokensRangeParams) => run(p.textDocument.uri, p.range));
}
