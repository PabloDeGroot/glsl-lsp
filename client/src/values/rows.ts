// Pure helpers for building row view-models. No `vscode` import.

import type { Range, ValueTarget } from '../../../shared/valuesProtocol';

/** `file:///c%3A/a/noise.glsl` -> `noise.glsl`. */
export function baseName(uri: string): string {
  const clean = uri.split(/[?#]/)[0];
  const last = clean.slice(clean.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Label of a target: name, else snippet. A palette child is prefixed with its parent (`palette.a`). */
export function labelFor(target: ValueTarget, parent?: ValueTarget): string {
  const own = target.name || target.snippet;
  if (parent && parent.kind === 'palette') {
    const base = parent.name || 'palette';
    return `${base}.${own}`;
  }
  return own;
}

export function sameRange(a: Range, b: Range): boolean {
  return a.start.line === b.start.line && a.start.character === b.start.character && a.end.line === b.end.line && a.end.character === b.end.character;
}

/** Same document location and kind (used to detect "already pinned"). */
export function sameTargetLocation(a: ValueTarget, b: ValueTarget): boolean {
  return a.uri === b.uri && a.kind === b.kind && sameRange(a.range, b.range);
}
