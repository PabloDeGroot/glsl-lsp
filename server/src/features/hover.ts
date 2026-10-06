// Hover: signature(s) + rendered doc comment + where the symbol is defined.
// Covers user functions (all overloads), LYGIA functions (YAML docs), structs,
// fields, macros, globals, #iUniforms, params, locals, builtins, swizzles and
// #include paths. All rendering lives in core/describe.ts so completion can
// reuse it.

import { MarkupKind, type Hover, type HoverParams } from 'vscode-languageserver/node';
import type { ServerContext } from '../context';
import { describeResolution, normalizeUri, type Range, type Resolution } from '../core';

/** Range the hover applies to (highlighted by the editor). */
function hoverRange(res: Resolution): Range | undefined {
  switch (res.kind) {
    case 'include':
      return res.include.pathRange;
    case 'symbol':
    case 'builtin':
      return res.occurrence?.range;
    case 'swizzle':
      return res.occurrence.range;
  }
}

/** Pure hover computation (also used by tests). */
export function computeHover(ctx: Pick<ServerContext, 'workspace'>, params: HoverParams): Hover | null {
  const uri = normalizeUri(params.textDocument.uri);
  const res = ctx.workspace.resolveSymbolAt(uri, params.position);
  if (!res) return null;
  const value = describeResolution(ctx.workspace, res, uri);
  if (!value) return null;
  return { contents: { kind: MarkupKind.Markdown, value }, range: hoverRange(res) };
}

export function register(ctx: ServerContext): void {
  ctx.connection.onHover((params) => {
    try {
      return computeHover(ctx, params);
    } catch (err) {
      ctx.log.error(`hover failed: ${(err as Error).stack ?? err}`);
      return null;
    }
  });
}
