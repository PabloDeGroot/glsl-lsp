// The optional shader-toy integration of the client: finding the extension's
// preview command, and the manifest wiring that keeps it optional.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREVIEW_COMMAND, previewCommandFrom, SHADER_TOY_CONTEXT_KEY, SHADER_TOY_ID } from '../client/src/shaderToyCore';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

describe('shader-toy preview command lookup', () => {
  it("uses the extension's own showGlslPreview command", () => {
    const manifest = {
      contributes: {
        commands: [
          { command: 'shader-toy.showStaticGlslPreview', title: 'Shader Toy: Show Static GLSL Preview' },
          { command: 'shader-toy.showGlslPreview', title: 'Shader Toy: Show GLSL Preview' },
          { command: 'shader-toy.createPortableGlslPreview', title: 'Shader Toy: Create Portable GLSL Preview' },
        ],
      },
    };
    expect(previewCommandFrom(manifest)).toBe('shader-toy.showGlslPreview');
  });

  it('follows a renamed live preview command, never a static or portable one', () => {
    const manifest = {
      contributes: { commands: [{ command: 'shader-toy.showStaticPreview' }, { command: 'shader-toy.showLivePreview' }] },
    };
    expect(previewCommandFrom(manifest)).toBe('shader-toy.showLivePreview');
  });

  it('falls back to the known command id', () => {
    expect(previewCommandFrom(undefined)).toBe(DEFAULT_PREVIEW_COMMAND);
    expect(previewCommandFrom({ contributes: {} })).toBe(DEFAULT_PREVIEW_COMMAND);
    expect(previewCommandFrom({ contributes: { commands: [{ command: 'shader-toy.pauseGlslPreviews' }] } })).toBe(DEFAULT_PREVIEW_COMMAND);
  });
});

describe('package.json keeps shader-toy optional', () => {
  it('never depends on the extension', () => {
    expect(pkg.extensionDependencies ?? []).not.toContain(SHADER_TOY_ID);
    expect(pkg.extensionPack ?? []).not.toContain(SHADER_TOY_ID);
  });

  it('shows the preview button and palette entry only when the extension is installed', () => {
    const when = `${SHADER_TOY_CONTEXT_KEY} && editorLangId == glsl`;
    expect(pkg.contributes.commands.find((c: { command: string }) => c.command === 'glslLsp.showShadertoyPreview')).toMatchObject({ title: 'Show Shadertoy Preview', category: 'GLSL' });
    expect(pkg.contributes.menus['editor/title']).toContainEqual(expect.objectContaining({ command: 'glslLsp.showShadertoyPreview', when }));
    expect(pkg.contributes.menus.commandPalette).toContainEqual({ command: 'glslLsp.showShadertoyPreview', when });
  });
});
