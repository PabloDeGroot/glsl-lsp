// Optional integration with the stevensona shader-toy extension, the parts
// that do not need the `vscode` module (unit tested): its id and how to find
// its preview command. The extension is never required; glsl-lsp only offers
// a shortcut to its preview when it is installed.

/** Marketplace id of the shader-toy extension. */
export const SHADER_TOY_ID = 'stevensona.shader-toy';

/** Its "Show GLSL Preview" command, as of shader-toy 0.11. */
export const DEFAULT_PREVIEW_COMMAND = 'shader-toy.showGlslPreview';

/** Context key set while the shader-toy extension is installed (gates the editor title button). */
export const SHADER_TOY_CONTEXT_KEY = 'glslLsp.shaderToyInstalled';

interface CommandContribution {
  command?: unknown;
  title?: unknown;
}

/**
 * The live preview command contributed by the shader-toy extension, read from
 * its package.json so a renamed command keeps working; falls back to
 * DEFAULT_PREVIEW_COMMAND. Static previews and portable exports are skipped.
 */
export function previewCommandFrom(packageJSON: unknown): string {
  const commands = (packageJSON as { contributes?: { commands?: CommandContribution[] } } | undefined)?.contributes?.commands;
  if (!Array.isArray(commands)) return DEFAULT_PREVIEW_COMMAND;
  const ids = commands.map((c) => (typeof c?.command === 'string' ? c.command : '')).filter(Boolean);
  if (ids.includes(DEFAULT_PREVIEW_COMMAND)) return DEFAULT_PREVIEW_COMMAND;
  const live = ids.find((id) => /show\w*preview$/i.test(id) && !/static|portable/i.test(id));
  return live ?? DEFAULT_PREVIEW_COMMAND;
}
