// VS Code extension entry point: starts the GLSL language server (dist/server.js)
// over IPC and contributes the restart / output / re-index commands, the
// Values side panel (./values) and the optional shader-toy integration
// (./shaderToy).

import * as path from 'node:path';
import { commands, ConfigurationTarget, window, workspace, type ExtensionContext, type OutputChannel } from 'vscode';
import { LanguageClient, State, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { isShaderToyInstalled, registerShaderToy } from './shaderToy';
import { registerValues } from './values';

/** Server notification with editor facts the settings do not carry (see server.ts). */
const CLIENT_ENVIRONMENT_NOTIFICATION = 'glslLsp/clientEnvironment';

const GLSL_GLOB = '**/*.{glsl,frag,vert,comp,geom,tesc,tese}';

let client: LanguageClient | undefined;
let output: OutputChannel | undefined;

function createClient(context: ExtensionContext): LanguageClient {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'glsl' },
      { scheme: 'untitled', language: 'glsl' },
    ],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher(GLSL_GLOB),
    },
    // Evaluated again on every (re)start, so a restart picks up the current state.
    initializationOptions: () => ({
      settings: workspace.getConfiguration('glslLsp'),
      shaderToyInstalled: isShaderToyInstalled(),
    }),
    outputChannel: output,
  };
  return new LanguageClient('glslLsp', 'GLSL Language Server', serverOptions, clientOptions);
}

/**
 * glslLsp.shadertoy.enable used to be a boolean. The server still accepts
 * true/false, but the settings editor flags them against the new enum:
 * rewrite them once as 'on'/'off' in whichever scope holds them.
 */
async function migrateLegacySettings(): Promise<void> {
  const config = workspace.getConfiguration('glslLsp');
  const info = config.inspect<unknown>('shadertoy.enable');
  if (!info) return;
  const scopes: [unknown, ConfigurationTarget][] = [
    [info.globalValue, ConfigurationTarget.Global],
    [info.workspaceValue, ConfigurationTarget.Workspace],
    [info.workspaceFolderValue, ConfigurationTarget.WorkspaceFolder],
  ];
  for (const [value, target] of scopes) {
    if (typeof value !== 'boolean') continue;
    try {
      await config.update('shadertoy.enable', value ? 'on' : 'off', target);
    } catch {
      // Read-only settings file or no folder for that scope: the server still maps the boolean.
    }
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
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
    if (client?.isRunning()) void client.sendNotification(CLIENT_ENVIRONMENT_NOTIFICATION, { shaderToyInstalled: isShaderToyInstalled() });
  };
  registerShaderToy(context, sendClientEnvironment);
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
