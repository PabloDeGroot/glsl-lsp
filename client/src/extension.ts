// VS Code extension entry point: starts the GLSL language server (dist/server.js)
// over IPC and contributes the restart / output / re-index commands, the
// Values side panel (./values) and the optional shader-toy integration
// (./shaderToy).
//
// The context key glslLsp.active (set on activation, which happens when a GLSL
// file is opened) shows the GLSL Activity Bar view, so workspaces without
// shaders do not get the icon.

import * as path from 'node:path';
import { commands, ConfigurationTarget, env, Uri, window, workspace, type ExtensionContext, type OutputChannel } from 'vscode';
import { LanguageClient, State, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { GLSL_FILE_GLOB } from '../../shared/glslFiles';
import { isShaderToyInstalled, registerShaderToy } from './shaderToy';
import { registerValues } from './values';

/** Server notification with editor facts the settings do not carry (see server.ts). */
const CLIENT_ENVIRONMENT_NOTIFICATION = 'glslLsp/clientEnvironment';
/** From the server: glslangValidator could not be started (see features/diagnostics.ts). */
const GLSLANG_MISSING_NOTIFICATION = 'glslLsp/glslangMissing';
/** globalState key: the user chose "Don't Show Again" on the missing-glslangValidator notice. */
const GLSLANG_NOTICE_DISMISSED = 'glslLsp.glslangMissingNoticeDismissed';
const GLSLANG_INSTALL_URL = 'https://github.com/PabloDeGroot/glsl-lsp/blob/main/docs/diagnostics.md#install-glslangvalidator';

let client: LanguageClient | undefined;
let output: OutputChannel | undefined;

function createClient(context: ExtensionContext): LanguageClient {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  // The extension's folder, not the workspace: nothing the server starts may resolve against an untrusted folder.
  const cwd = context.extensionPath;
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc, options: { cwd } },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { cwd, execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'glsl' },
      { scheme: 'untitled', language: 'glsl' },
    ],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher(GLSL_FILE_GLOB),
    },
    // Evaluated again on every (re)start, so a restart picks up the current state.
    initializationOptions: () => ({
      settings: workspace.getConfiguration('glslLsp'),
      shaderToyInstalled: isShaderToyInstalled(),
      workspaceTrusted: workspace.isTrusted,
    }),
    outputChannel: output,
  };
  return new LanguageClient('glslLsp', 'GLSL Language Server', serverOptions, clientOptions);
}

/**
 * glslLsp.shadertoy.enable used to be a boolean. The server still accepts
 * true/false, but the settings editor flags them against the new enum:
 * rewrite a user-settings value once as 'on'/'off'. Workspace settings are
 * files in someone's repository, so they are left as they are.
 */
async function migrateLegacySettings(): Promise<void> {
  const config = workspace.getConfiguration('glslLsp');
  const value = config.inspect<unknown>('shadertoy.enable')?.globalValue;
  if (typeof value !== 'boolean') return;
  try {
    await config.update('shadertoy.enable', value ? 'on' : 'off', ConfigurationTarget.Global);
  } catch {
    // Read-only settings file: the server still maps the boolean.
  }
}

interface GlslangMissingParams {
  path: string;
  detail?: string;
}

/**
 * glslangValidator is optional: when the default lookup fails, say so once
 * with a way to install it, turn compiler checks off or never be told again.
 * A path the user set explicitly is a misconfiguration and always warns.
 */
async function onGlslangMissing(context: ExtensionContext, params: GlslangMissingParams): Promise<void> {
  const info = workspace.getConfiguration('glslLsp').inspect<string>('diagnostics.glslang.path');
  // Restricted Mode ignores workspace values; an empty path means the default.
  const values = workspace.isTrusted ? [info?.globalValue, info?.workspaceValue, info?.workspaceFolderValue] : [info?.globalValue];
  const configured = values.some((v) => typeof v === 'string' && v.trim() !== '');
  if (configured) {
    const open = 'Open Setting';
    const pick = await window.showWarningMessage(
      `glslangValidator could not be started from '${params.path}'${params.detail ? ` (${params.detail})` : ''}. GLSL compiler errors are off; the other checks still run.`,
      open,
    );
    if (pick === open) await commands.executeCommand('workbench.action.openSettings', 'glslLsp.diagnostics.glslang.path');
    return;
  }
  if (context.globalState.get<boolean>(GLSLANG_NOTICE_DISMISSED)) {
    output?.appendLine('glslangValidator was not found on PATH: GLSL compiler errors are off.');
    return;
  }
  const install = 'How to Install';
  const turnOff = 'Turn Off Compiler Checks';
  const never = "Don't Show Again";
  const pick = await window.showInformationMessage(
    'glslangValidator was not found, so GLSL compiler errors are off. Completion, navigation and the other checks work without it.',
    install,
    turnOff,
    never,
  );
  if (pick === install) await env.openExternal(Uri.parse(GLSLANG_INSTALL_URL));
  else if (pick === turnOff) await workspace.getConfiguration('glslLsp').update('diagnostics.glslang.enable', false, ConfigurationTarget.Global);
  else if (pick === never) await context.globalState.update(GLSLANG_NOTICE_DISMISSED, true);
}

export async function activate(context: ExtensionContext): Promise<void> {
  void commands.executeCommand('setContext', 'glslLsp.active', true);
  output = window.createOutputChannel('GLSL Language Server');
  await migrateLegacySettings();
  context.subscriptions.push(output);
  client = createClient(context);

  context.subscriptions.push(
    commands.registerCommand('glslLsp.restartServer', async () => {
      if (!client) return;
      output?.appendLine('Restarting GLSL language server...');
      await client.restart();
    }),
    commands.registerCommand('glslLsp.showOutput', () => output?.show(true)),
    commands.registerCommand('glslLsp.reindex', async () => {
      if (!client) return;
      const res = await client.sendRequest<{ files: number }>('glslLsp/reindex');
      window.setStatusBarMessage(`GLSL: indexed ${res.files} files`, 3000);
    }),
  );

  registerValues(context, () => client);
  const sendClientEnvironment = () => {
    if (client?.isRunning()) {
      void client.sendNotification(CLIENT_ENVIRONMENT_NOTIFICATION, { shaderToyInstalled: isShaderToyInstalled(), workspaceTrusted: workspace.isTrusted });
    }
  };
  registerShaderToy(context, sendClientEnvironment);
  context.subscriptions.push(
    workspace.onDidGrantWorkspaceTrust(sendClientEnvironment),
    client.onNotification(GLSLANG_MISSING_NOTIFICATION, (params: GlslangMissingParams) => void onGlslangMissing(context, params)),
  );
  // A change between reading initializationOptions and the server running would be lost:
  // re-send the current state whenever the server is up (the server ignores no-op updates).
  context.subscriptions.push(
    client.onDidChangeState((e) => {
      if (e.newState === State.Running) sendClientEnvironment();
    }),
  );

  await client.start();
}

export async function deactivate(): Promise<void> {
  if (client) await client.stop();
  client = undefined;
}
