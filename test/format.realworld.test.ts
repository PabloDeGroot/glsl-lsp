// Formatter invariants over every .glsl file of a real shader workspace
// (GLSL_LSP_E2E_ROOT, or this repository's parent when it looks like one;
// see realWorkspace.ts), LYGIA included. Skipped without one. Files are only
// read, never written.
//
//   1. tokens: the non-whitespace token sequence (comments included) is unchanged
//   2. idempotence: format(format(x)) === format(x)
//   3. conservative mode changes only indentation, trailing whitespace, blank
//      lines, the final newline and spaces after `,`/`;` and around assignments

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatText, resolveFormatOptions, type FormatSettings } from '../server/src/features/format/index';
import { conservativeViolation, invariantProblems } from './formatHelpers';
import { REAL_ROOT, REPO } from './realWorkspace';

/** Every .glsl file under the workspace (LYGIA included), skipping dot folders, node_modules, build output and this repository. */
function allGlslFiles(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', 'out', 'dist', '.vscode-test']);
  const walk = (dir: string) => {
    if (existsSync(join(dir, '.glsl-lsp-ignore'))) return;
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!name.startsWith('.') && !skip.has(name) && resolve(full) !== REPO) walk(full);
      } else if (name.endsWith('.glsl')) out.push(full);
    }
  };
  walk(root);
  return out;
}

const FILES = REAL_ROOT ? allGlslFiles(REAL_ROOT) : [];
const rel = (f: string) => relative(REAL_ROOT ?? '', f).replace(/\\/g, '/');

const MODES: { name: string; settings: Partial<FormatSettings>; editor?: { tabSize: number; insertSpaces: boolean } }[] = [
  { name: 'conservative', settings: { mode: 'conservative' } },
  { name: 'conservative, tabs', settings: { mode: 'conservative' }, editor: { tabSize: 4, insertSpaces: false } },
  { name: 'opinionated', settings: { mode: 'opinionated' } },
  { name: 'opinionated sameLine', settings: { mode: 'opinionated', braceStyle: 'sameLine' } },
  { name: 'opinionated nextLine, 2 spaces', settings: { mode: 'opinionated', braceStyle: 'nextLine' }, editor: { tabSize: 2, insertSpaces: true } },
  { name: 'indentPreprocessor', settings: { mode: 'conservative', indentPreprocessor: true } },
];

describe.skipIf(!REAL_ROOT || FILES.length === 0)('format: invariants over the real workspace', () => {
  for (const m of MODES) {
    it(`${m.name}: tokens preserved and idempotent`, () => {
      const problems: string[] = [];
      let changed = 0;
      for (const f of FILES) {
        const text = readFileSync(f, 'utf8');
        const p = invariantProblems(text, m.settings, m.editor);
        if (p.length) problems.push(`${rel(f)}: ${p.join(', ')}`);
        if (formatText(text, resolveFormatOptions(m.editor ?? { tabSize: 4, insertSpaces: true }, m.settings)) !== text) changed++;
      }
      console.log(`format (${m.name}): ${FILES.length} files, ${changed} would change, ${problems.length} problems`);
      expect(problems).toEqual([]);
    }, 120_000);
  }

  it('conservative changes nothing but the listed items', () => {
    const opts = resolveFormatOptions({ tabSize: 4, insertSpaces: true }, { mode: 'conservative' });
    const problems: string[] = [];
    for (const f of FILES) {
      const text = readFileSync(f, 'utf8');
      const v = conservativeViolation(text, formatText(text, opts));
      if (v) problems.push(`${rel(f)}: ${v}`);
    }
    expect(problems).toEqual([]);
  }, 120_000);
});
