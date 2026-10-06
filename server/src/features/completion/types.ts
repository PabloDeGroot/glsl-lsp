// Shared types for the completion modules.

import type { Workspace } from '../../core';

/** Everything completion needs; a subset of ServerContext so tests can build it directly. */
export interface CompletionEnv {
  workspace: Workspace;
  /** Client accepts snippet insert text. */
  snippetSupport: boolean;
  /** glslLsp.completion.autoInclude */
  autoInclude: boolean;
}

/**
 * `CompletionItem.data`, kept tiny: documentation is computed in
 * completionItem/resolve from this.
 *  - k 'g': top-level symbol(s) named `n` declared in file `f`
 *  - k 'b': builtin entry `n` (function, variable, type, keyword, macro, directive)
 */
export type CompletionData =
  | { k: 'g'; u: string; n: string; f: string; inc?: string }
  | { k: 'b'; u: string; n: string; d?: boolean };

/**
 * sortText rank prefixes: locals > this file > included files > builtins >
 * keywords > not-yet-included workspace symbols.
 */
export const Rank = {
  local: '0',
  member: '0',
  file: '1',
  included: '2',
  builtin: '3',
  keyword: '4',
  workspace: '5',
} as const;

export function sortText(rank: string, name: string, extra = ''): string {
  return `${rank}${extra}_${name}`;
}
