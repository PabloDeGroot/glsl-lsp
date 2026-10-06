// Semantic token legend shared by server.ts (advertised in onInitialize) and
// features/semanticTokens.ts (encoding). Append new types/modifiers at the
// END only: indices are part of the protocol between server and client.

export const tokenTypes = [
  'namespace',
  'type',
  'struct',
  'parameter',
  'variable',
  'property',
  'function',
  'macro',
  'keyword',
  'comment',
  'string',
  'number',
  'operator',
  // Appended by the presentation features (keep indices of the entries above stable).
  'enumMember',
] as const;

export const tokenModifiers = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'modification',
  'defaultLibrary',
] as const;

export type SemanticTokenType = (typeof tokenTypes)[number];
export type SemanticTokenModifier = (typeof tokenModifiers)[number];

export const semanticTokensLegend = {
  tokenTypes: [...tokenTypes] as string[],
  tokenModifiers: [...tokenModifiers] as string[],
};

const typeIndex = new Map<string, number>(tokenTypes.map((t, i) => [t, i]));
const modifierBit = new Map<string, number>(tokenModifiers.map((m, i) => [m, 1 << i]));

export function tokenTypeIndex(type: SemanticTokenType): number {
  return typeIndex.get(type)!;
}

export function modifierMask(...mods: SemanticTokenModifier[]): number {
  let mask = 0;
  for (const m of mods) mask |= modifierBit.get(m)!;
  return mask;
}
