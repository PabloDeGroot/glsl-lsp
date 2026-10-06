// One list of GLSL file extensions (shared/glslFiles.ts) for the server, the
// client's watcher, package.json and the grammar.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLSL_FILE_EXTENSIONS, GLSL_FILE_GLOB } from '../shared/glslFiles';
import { isGlslPath } from '../server/src/core';

const read = (p: string) => JSON.parse(readFileSync(resolve(__dirname, '..', p), 'utf8'));

describe('GLSL file extensions', () => {
  it('package.json claims exactly the shared list', () => {
    const glsl = read('package.json').contributes.languages.find((l: { id: string }) => l.id === 'glsl');
    expect(glsl.extensions).toEqual(GLSL_FILE_EXTENSIONS);
  });

  it('the grammar lists the same file types', () => {
    expect(read('syntaxes/glsl.tmLanguage.json').fileTypes).toEqual(GLSL_FILE_EXTENSIONS.map((e) => e.slice(1)));
  });

  it('indexes the new extensions but not other languages', () => {
    for (const f of ['a.vsh', 'a.fsh', 'a.gsh', 'a.vshader', 'a.glslf', 'a.glslg']) expect(isGlslPath(f)).toBe(true);
    for (const f of ['Program.fs', 'shader.vs', 'Code.gs', 'Unity.shader', 'model.mesh', 'build.task', 'hit.rchit']) expect(isGlslPath(f)).toBe(false);
  });

  it('builds the watcher glob from the list', () => {
    expect(GLSL_FILE_GLOB).toBe(`**/*.{${GLSL_FILE_EXTENSIONS.map((e) => e.slice(1)).join(',')}}`);
    expect(GLSL_FILE_GLOB).toContain(',vsh,');
  });
});
