// VS Code extension entry point: starts the GLSL language server (dist/server.js)
// over IPC and contributes the restart / output / re-index commands.

import * as path from 'node:path';
import { commands, window, workspace, type ExtensionContext, type OutputChannel } from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';

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
    initializationOptions: {
      settings: workspace.getConfiguration('glslLsp'),
    },
    outputChannel: output,
  };
  return new LanguageClient('glslLsp', 'GLSL Language Server', serverOptions, clientOptions);
}

export async function activate(context: ExtensionContext): Promise<void> {
  output = window.createOutputChannel('GLSL Language Server');
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

  await client.start();
}

export async function deactivate(): Promise<void> {
  if (client) await client.stop();
  client = undefined;
}
