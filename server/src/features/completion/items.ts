// Building blocks for CompletionItems: kinds, details and function call
// insert text for user symbols and builtins.

import {
  Command,
  CompletionItemKind,
  CompletionItemTag,
  InsertTextFormat,
  type CompletionItem,
} from 'vscode-languageserver/node';
import type { BuiltinEntry, BuiltinFunction } from '../../builtins';
import {
  formatBuiltinOverload,
  formatField,
  formatFunction,
  formatMacro,
  formatParam,
  formatVariable,
  type FunctionSymbol,
  type GlslSymbol,
} from '../../core';
import type { CompletionEnv } from './types';

export const TRIGGER_PARAMETER_HINTS: Command = Command.create('Trigger Parameter Hints', 'editor.action.triggerParameterHints');
export const TRIGGER_SUGGEST: Command = Command.create('Trigger Suggest', 'editor.action.triggerSuggest');

export function symbolKind(s: GlslSymbol): CompletionItemKind {
  switch (s.kind) {
    case 'function':
      return CompletionItemKind.Function;
    case 'parameter':
      return CompletionItemKind.Variable;
    case 'variable':
      return s.qualifiers.includes('const') ? CompletionItemKind.Constant : CompletionItemKind.Variable;
    case 'struct':
      return CompletionItemKind.Struct;
    case 'field':
      return CompletionItemKind.Field;
    case 'macro':
      return s.params ? CompletionItemKind.Function : CompletionItemKind.Constant;
    case 'block':
      return CompletionItemKind.Interface;
  }
}

export function builtinKind(e: BuiltinEntry): CompletionItemKind {
  switch (e.kind) {
    case 'function':
      return CompletionItemKind.Function;
    case 'variable':
      return e.value !== undefined || e.qualifiers?.includes('const') ? CompletionItemKind.Constant : CompletionItemKind.Variable;
    case 'type':
      return CompletionItemKind.Class;
    case 'keyword':
      return CompletionItemKind.Keyword;
    case 'macro':
      return CompletionItemKind.Constant;
    case 'directive':
      return CompletionItemKind.Keyword;
  }
}

/** One-line detail for a group of same-named symbols (overloads). */
export function symbolDetail(symbols: readonly GlslSymbol[]): string {
  const s = symbols[0];
  switch (s.kind) {
    case 'function': {
      const fns = symbols.filter((x): x is FunctionSymbol => x.kind === 'function');
      const extra = fns.length > 1 ? ` (+${fns.length - 1} overload${fns.length > 2 ? 's' : ''})` : '';
      return formatFunction(fns[0]) + extra;
    }
    case 'struct':
      return `struct ${s.name}`;
    case 'block':
      return `${s.qualifiers.join(' ')} ${s.name}`.trim();
    case 'macro':
      return formatMacro(s, 80);
    case 'variable':
      return formatVariable(s);
    case 'parameter':
      return formatParam(s);
    case 'field':
      return formatField(s);
  }
}

/** `(vec2 st)` shown right after the label for functions. */
export function paramsLabel(symbols: readonly GlslSymbol[]): string | undefined {
  const s = symbols[0];
  if (s.kind === 'function') return `(${s.params.map(formatParam).join(', ')})`;
  if (s.kind === 'macro' && s.params) return `(${s.params.join(', ')})`;
  return undefined;
}

export function builtinDetail(e: BuiltinEntry): string {
  switch (e.kind) {
    case 'function': {
      const first = e.overloads[0];
      if (!first) return e.name;
      const extra = e.overloads.length > 1 ? ` (+${e.overloads.length - 1} overload${e.overloads.length > 2 ? 's' : ''})` : '';
      return formatBuiltinOverload(e.name, first) + extra;
    }
    case 'variable': {
      const q = e.qualifiers?.length ? e.qualifiers.join(' ') + ' ' : '';
      return `${q}${e.type} ${e.name}${e.value !== undefined ? ' = ' + e.value : ''}`;
    }
    case 'type':
      return 'type';
    case 'keyword':
      return e.category === 'qualifier' ? 'qualifier' : 'keyword';
    case 'macro':
      return `#define ${e.name}${e.value !== undefined ? ' ' + e.value : ''}`;
    case 'directive':
      return '#' + e.name;
  }
}

export function builtinParamsLabel(e: BuiltinFunction): string | undefined {
  const o = e.overloads[0];
  if (!o) return undefined;
  return `(${o.params.map((p) => `${p.type} ${p.name}`).join(', ')})`;
}

/**
 * Call insertion for functions / function-like macros: `name($0)` as a
 * snippet (then signature help pops up), `name()` when nothing takes
 * arguments, plain `name` without snippet support or when a `(` already
 * follows the cursor.
 */
export function applyCallInsert(item: CompletionItem, name: string, hasParams: boolean, env: CompletionEnv, parenFollows: boolean) {
  if (parenFollows || !env.snippetSupport) return;
  if (hasParams) {
    item.insertText = `${name}($0)`;
    item.insertTextFormat = InsertTextFormat.Snippet;
    item.command = TRIGGER_PARAMETER_HINTS;
  } else {
    item.insertText = `${name}()`;
    item.insertTextFormat = InsertTextFormat.PlainText;
  }
}

export function deprecatedTags(e: BuiltinEntry): CompletionItemTag[] | undefined {
  return 'deprecated' in e && e.deprecated ? [CompletionItemTag.Deprecated] : undefined;
}
