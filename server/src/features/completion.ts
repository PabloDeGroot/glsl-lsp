// Completion: context aware (members after `.`, directives after `#`,
// `#include` paths, macro names in #ifdef...), scope-aware identifiers, and
// auto-include: symbols from files that are not included yet, which add the
// right `#include "..."` line when selected.
//
// The logic lives in ./completion/*:
//   context.ts       classify the cursor position
//   identifiers.ts   locals/file/includes/builtins/keywords + not-yet-included symbols
//   members.ts       struct fields, swizzles, length()
//   preprocessor.ts  directive names, #ifdef macros, #version, #extension
//   includePaths.ts  #include "path" completion
//   resolveItem.ts   lazy documentation (completionItem/resolve)
// and ./autoInclude.ts (shared with code actions) picks the file to include.

import type { CompletionItem, CompletionList, CompletionParams } from 'vscode-languageserver/node';
import type { ServerContext } from '../context';
import { normalizeUri } from '../core';
import { analyzeContext } from './completion/context';
import { identifierCompletions } from './completion/identifiers';
import { includePathCompletions } from './completion/includePaths';
import { memberCompletions } from './completion/members';
import { directiveNameCompletions, extensionCompletions, macroNameCompletions, versionCompletions } from './completion/preprocessor';
import { resolveCompletionItem } from './completion/resolveItem';
import type { CompletionEnv } from './completion/types';

export type { CompletionEnv } from './completion/types';
export { resolveCompletionItem } from './completion/resolveItem';

/** Pure completion computation (used by tests). */
export function computeCompletion(env: CompletionEnv, params: CompletionParams): CompletionList | null {
  const uri = normalizeUri(params.textDocument.uri);
  const model = env.workspace.getModel(uri);
  if (!model) return null;
  const offset = model.lines.offsetAt(params.position);
  const ctx = analyzeContext(model, offset);
  const trigger = params.context?.triggerCharacter;

  switch (ctx.kind) {
    case 'none':
      return null;
    case 'directiveName':
      if (trigger && trigger !== '#') return null;
      return list(directiveNameCompletions(env, model, model.lines.range(ctx.wordStart, offset)));
    case 'includePath':
      if (trigger === '.' || trigger === '#') return null;
      return list(includePathCompletions(env, model, ctx));
    case 'macroName':
      if (trigger) return null;
      return list(macroNameCompletions(env, model, offset, ctx.allowDefined));
    case 'version':
      return trigger ? null : list(versionCompletions(model.lines.range(ctx.wordStart, offset)));
    case 'extension':
      return trigger ? null : list(extensionCompletions(env, model.lines.range(ctx.wordStart, offset)));
    case 'member':
      if (trigger && trigger !== '.') return null;
      // Swizzle extensions depend on the typed text.
      return { isIncomplete: true, items: memberCompletions(env, model, ctx.dot, ctx.word) };
    case 'identifier': {
      if (trigger) return null; // '#', '"', '/', '.' outside their contexts (e.g. division)
      const r = identifierCompletions(env, model, { word: ctx.word, wordStart: ctx.wordStart, offset, inDirective: ctx.inDirective });
      return { isIncomplete: r.isIncomplete, items: r.items };
    }
  }
}

function list(items: CompletionItem[]): CompletionList {
  return { isIncomplete: false, items };
}

function envOf(ctx: ServerContext): CompletionEnv {
  return {
    workspace: ctx.workspace,
    snippetSupport: ctx.clientCapabilities.snippetSupport,
    autoInclude: ctx.settings.get().completion.autoInclude,
  };
}

export function register(ctx: ServerContext): void {
  ctx.connection.onCompletion((params) => {
    try {
      return computeCompletion(envOf(ctx), params);
    } catch (err) {
      ctx.log.error(`completion failed: ${(err as Error).stack ?? err}`);
      return null;
    }
  });
  ctx.connection.onCompletionResolve((item) => {
    try {
      return resolveCompletionItem(ctx.workspace, item);
    } catch (err) {
      ctx.log.error(`completion resolve failed: ${(err as Error).stack ?? err}`);
      return item;
    }
  });
}
