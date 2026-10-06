// Optional shader-toy (stevensona.shader-toy) integration: tracks whether the
// extension is installed (a context key for the editor title button, and a
// notification so the server's 'auto' Shadertoy mode can use it) and
// contributes "GLSL: Show Shadertoy Preview", which delegates to the
// extension's own preview command. Nothing here requires the extension.

import { commands, env, extensions, Uri, window, type Disposable, type ExtensionContext } from 'vscode';
import { previewCommandFrom, SHADER_TOY_CONTEXT_KEY, SHADER_TOY_ID } from './shaderToyCore';

export function isShaderToyInstalled(): boolean {
  return !!extensions.getExtension(SHADER_TOY_ID);
}

async function showPreview(): Promise<void> {
  const ext = extensions.getExtension(SHADER_TOY_ID);
  if (!ext) {
    const install = 'Show Extension';
    const choice = await window.showInformationMessage(
      'The Shadertoy preview is provided by the optional shader-toy extension (stevensona.shader-toy), which is not installed.',
      install,
    );
    if (choice === install) {
      await commands.executeCommand('workbench.extensions.search', SHADER_TOY_ID).then(undefined, () =>
        env.openExternal(Uri.parse(`https://marketplace.visualstudio.com/items?itemName=${SHADER_TOY_ID}`)),
      );
    }
    return;
  }
  if (!ext.isActive) await ext.activate();
  await commands.executeCommand(previewCommandFrom(ext.packageJSON));
}

/**
 * Registers the preview command and keeps the context key up to date.
 * `onChange` runs when the extension gets installed or removed.
 */
export function registerShaderToy(context: ExtensionContext, onChange: (installed: boolean) => void): Disposable {
  let installed = isShaderToyInstalled();
  void commands.executeCommand('setContext', SHADER_TOY_CONTEXT_KEY, installed);
  const subscriptions: Disposable[] = [
    commands.registerCommand('glslLsp.showShadertoyPreview', showPreview),
    extensions.onDidChange(() => {
      const now = isShaderToyInstalled();
      if (now === installed) return;
      installed = now;
      void commands.executeCommand('setContext', SHADER_TOY_CONTEXT_KEY, installed);
      onChange(installed);
    }),
  ];
  const disposable = { dispose: () => subscriptions.forEach((s) => s.dispose()) };
  context.subscriptions.push(disposable);
  return disposable;
}
