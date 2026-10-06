// Member completion after `.`: struct / interface block fields, vector
// swizzles sized to the vector type, and `length()` on arrays.

import { CompletionItemKind, InsertTextFormat, type CompletionItem } from 'vscode-languageserver/node';
import {
  findStructType,
  formatDocMarkdown,
  formatField,
  typeOfExpressionEndingAt,
  type FileModel,
  type TypeRef,
  type Workspace,
} from '../../core';
import { Rank, sortText, type CompletionEnv } from './types';

const VECTOR_RE = /^([biud]?)vec([234])$/;
const COMPONENT: Record<string, string> = { '': 'float', b: 'bool', i: 'int', u: 'uint', d: 'double' };
export const SWIZZLE_SETS = ['xyzw', 'rgba', 'stpq'] as const;

/** Result type of a swizzle of `size` components on a vector with element prefix `p` ('' | b | i | u | d). */
function swizzleResult(prefix: string, size: number): string {
  return size === 1 ? COMPONENT[prefix] : `${prefix}vec${size}`;
}

/** Ordered subsets of `chars` (keeps component order), shortest first. */
function orderedSubsets(chars: string): string[] {
  const out: string[] = [];
  const n = chars.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let s = '';
    for (let i = 0; i < n; i++) if (mask & (1 << i)) s += chars[i];
    out.push(s);
  }
  return out.sort((a, b) => a.length - b.length || chars.indexOf(a[0]) - chars.indexOf(b[0]) || a.localeCompare(b));
}

/**
 * Swizzle items for a vector of `components` components. Offers every
 * ordered subset of each component set, plus extensions of the typed swizzle
 * (`xx` -> `xxy`...) so repeated/reordered swizzles can be built up.
 */
export function swizzleItems(vectorType: string, typed: string): CompletionItem[] {
  const m = VECTOR_RE.exec(vectorType);
  if (!m) return [];
  const prefix = m[1];
  const n = Number(m[2]);
  const items = new Map<string, CompletionItem>();
  const add = (sw: string, setIndex: number, order: number) => {
    if (items.has(sw) || sw.length > 4) return;
    items.set(sw, {
      label: sw,
      kind: CompletionItemKind.Field,
      detail: `${swizzleResult(prefix, sw.length)} (swizzle of ${vectorType})`,
      sortText: sortText(Rank.member, sw, `${setIndex}${sw.length}${String(order).padStart(2, '0')}`),
    });
  };
  SWIZZLE_SETS.forEach((set, si) => {
    const chars = set.slice(0, n);
    orderedSubsets(chars).forEach((sw, i) => add(sw, si, i));
    // Extend what the user already typed when it is a valid swizzle of this set.
    if (typed && typed.length < 4 && [...typed].every((c) => chars.includes(c))) {
      add(typed, si, 0);
      [...chars].forEach((c, i) => add(typed + c, si, i + 1));
    }
  });
  return [...items.values()];
}

/** Static type of the expression that ends right before `dot` (identifier, call, index, member). */
export function receiverType(ws: Workspace, model: FileModel, dot: number): TypeRef | undefined {
  return typeOfExpressionEndingAt(ws, model, dot);
}

export function memberCompletions(env: CompletionEnv, model: FileModel, dot: number, typed: string): CompletionItem[] {
  const ws = env.workspace;
  const type = receiverType(ws, model, dot);
  if (!type) return [];
  if (type.array) {
    const item: CompletionItem = { label: 'length', kind: CompletionItemKind.Method, detail: 'int length()', sortText: sortText(Rank.member, 'length') };
    if (env.snippetSupport) {
      item.insertText = 'length()';
      item.insertTextFormat = InsertTextFormat.PlainText;
    }
    return [item];
  }
  if (VECTOR_RE.test(type.name)) return swizzleItems(type.name, typed);
  const st = findStructType(ws, model, type.name, dot);
  if (!st) return [];
  return st.fields.map((f, i) => {
    const doc = formatDocMarkdown(f.doc);
    return {
      label: f.name,
      kind: CompletionItemKind.Field,
      detail: formatField(f),
      labelDetails: { description: f.type.name + (f.type.array ?? '') },
      sortText: sortText(Rank.member, f.name, String(i).padStart(3, '0')),
      documentation: doc ? { kind: 'markdown', value: doc } : undefined,
    } satisfies CompletionItem;
  });
}
