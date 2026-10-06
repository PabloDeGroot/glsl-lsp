// LYGIA-style option macros ("knobs") such as `GNOISE_NOISE_FNC` or
// `FBM_OCTAVES`: a file provides a default with `#ifndef X / #define X ...`
// and the user overrides it by defining X *before* including the file.
// Auto-include, workspace symbols and diagnostics treat them specially.

import { optionDescription } from './docs';
import type { FileModel, MacroSymbol } from './model';

/**
 * True when `macro` (declared in `model`) is an option setting: either
 * listed under `options:` in the file's doc block, or a self-guarded default
 * (`#ifndef X` / `#define X ...`) whose name starts with one of the file's
 * function names (`FBM_OCTAVES` next to `fbm`).
 */
export function isOptionMacro(model: FileModel | undefined, macro: MacroSymbol): boolean {
  if (!model || macro.isIncludeGuard) return false;
  const yaml = model.fileDoc?.yaml;
  if (yaml && optionDescription(yaml, macro.name) !== undefined) return true;
  const upper = macro.name.toUpperCase();
  if (!model.functions.some((f) => upper.startsWith(f.name.toUpperCase() + '_'))) return false;
  return model.conditionals.some(
    (c) =>
      c.macro === macro.name &&
      c.branches[0]?.kind === 'ifndef' &&
      c.branches[0].end <= macro.nameOffset &&
      (!c.endif || macro.nameOffset < c.endif.start),
  );
}
