// Locates an optional real shader workspace (for example one with LYGIA next
// to its shaders) for the tests that run against real files:
//
//   1. GLSL_LSP_E2E_ROOT, when set (an error when it is not an existing
//      folder, so a typo does not silently skip everything);
//   2. otherwise the directory containing this repository.
//
// Either is used only when it looks like a shader workspace (a lygia/ folder,
// or .glsl files at the top or one folder down). Otherwise REAL_ROOT is
// undefined and those tests are skipped.
// Every file found there is read-only test material: tests never write to it.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

export const REPO = resolve(__dirname, '..');

/** A lygia/ folder, or .glsl files at the top or one folder down (not in dot folders, node_modules or this repository). */
function looksLikeShaderWorkspace(dir: string): boolean {
  const hasGlsl = (d: string) => readdirSync(d).some((n) => n.endsWith('.glsl'));
  try {
    if (existsSync(join(dir, 'lygia')) || hasGlsl(dir)) return true;
    return readdirSync(dir, { withFileTypes: true }).some(
      (e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && resolve(dir, e.name) !== REPO && hasGlsl(join(dir, e.name)),
    );
  } catch {
    return false;
  }
}

function locate(): string | undefined {
  const env = process.env.GLSL_LSP_E2E_ROOT;
  if (env) {
    // Set explicitly: a typo must not silently skip every real-workspace test.
    if (!existsSync(env) || !statSync(env).isDirectory()) throw new Error(`GLSL_LSP_E2E_ROOT is set but is not a folder: ${env}`);
    // An existing folder without shaders has nothing to test: skip rather than pass vacuously.
    return looksLikeShaderWorkspace(env) ? resolve(env) : undefined;
  }
  const parent = resolve(REPO, '..');
  return looksLikeShaderWorkspace(parent) ? parent : undefined;
}

/** The real shader workspace, or undefined (tests skip). */
export const REAL_ROOT: string | undefined = locate();

/** `REAL_ROOT/lygia` when present. */
export const REAL_LYGIA: string | undefined = REAL_ROOT && existsSync(join(REAL_ROOT, 'lygia')) ? join(REAL_ROOT, 'lygia') : undefined;

/** Folders never treated as the workspace's own shaders: third-party code, build output and this repository. */
export const REAL_EXCLUDE = ['node_modules', '.git', 'out', 'dist', '.vscode-test', 'lygia', basename(REPO)];

/** True when every path (relative to REAL_ROOT) exists. */
export function realHas(...paths: string[]): boolean {
  return !!REAL_ROOT && paths.every((p) => existsSync(join(REAL_ROOT!, p)));
}

/**
 * The workspace's own .glsl files (relative paths with `/`), up to `maxDepth`
 * folders deep, skipping REAL_EXCLUDE, dot folders and folders holding a
 * `.glsl-lsp-ignore` marker.
 */
export function realShaderFiles(maxDepth = 3): string[] {
  if (!REAL_ROOT) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (existsSync(join(dir, '.glsl-lsp-ignore'))) return;
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (depth < maxDepth && !name.startsWith('.') && !REAL_EXCLUDE.includes(name) && resolve(full) !== REPO) walk(full, depth + 1);
      } else if (name.endsWith('.glsl')) out.push(relative(REAL_ROOT!, full).replace(/\\/g, '/'));
    }
  };
  walk(REAL_ROOT, 0);
  return out;
}

/** Entry shaders: files defining `mainImage` or `main`. */
export function isEntryShader(text: string): boolean {
  return /\bvoid\s+(mainImage|main)\s*\(/.test(text);
}
