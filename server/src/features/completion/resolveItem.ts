// completionItem/resolve: fills `documentation` lazily from `item.data`
// so completion lists stay light (LYGIA closures have hundreds of symbols).

import { MarkupKind, type CompletionItem } from 'vscode-languageserver/node';
import { describeBuiltin, describeSymbols, type GlslSymbol, type Workspace } from '../../core';
import type { CompletionData } from './types';

function isCompletionData(d: unknown): d is CompletionData {
  return typeof d === 'object' && d !== null && typeof (d as { k?: unknown }).k === 'string' && typeof (d as { n?: unknown }).n === 'string';
}

export function resolveCompletionItem(ws: Workspace, item: CompletionItem): CompletionItem {
  const data = item.data;
  if (!isCompletionData(data) || item.documentation) return item;
  let value: string | undefined;
  if (data.k === 'g') {
    const model = ws.getModel(data.f);
    const symbols: GlslSymbol[] = model
      ? model.symbols.filter((s) => s.name === data.n && !(s.kind === 'macro' && s.isIncludeGuard))
      : ws.lookupGlobal(data.n).filter((s) => s.uri === data.f);
    if (!symbols.length) return item;
    // Visible items: the overloads across the include closure, defined in this file first.
    let all: GlslSymbol[] = symbols;
    if (!data.inc && symbols[0].kind === 'function') {
      all = [...symbols, ...ws.lookupGlobal(data.n).filter((s) => s.kind === 'function' && s.uri !== data.f && ws.isReachable(data.u, s.uri))];
    }
    // Auto-include items say which include they add (below) instead of hover's "not included here" note.
    value = describeSymbols(ws, all, all[0], { fromUri: data.inc ? undefined : data.u });
    if (data.inc) value += `\n\n---\n\nAdds \`#include "${data.inc}"\``;
  } else {
    const b = ws.builtins;
    const entry = data.d ? b.directives.get(data.n) : b.get(data.n);
    if (entry) value = describeBuiltin(entry);
  }
  if (value) item.documentation = { kind: MarkupKind.Markdown, value };
  return item;
}
