// Language server entry point: wires the connection, document sync, settings
// and the workspace index together, advertises capabilities and registers
// every feature module. Feature logic lives in ./features/*.

import {
  CodeActionKind,
  createConnection,
  DidChangeConfigurationNotification,
  FileChangeType,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type InitializeParams,
  type InitializeResult,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Builtins, builtinData } from './builtins';
import type { Logger, ServerContext } from './context';
import { NodeFileSystem, normalizeUri, semanticTokensLegend, Workspace } from './core';
import * as codeActions from './features/codeActions';
import * as colors from './features/colors';
import * as completion from './features/completion';
import * as diagnostics from './features/diagnostics';
import * as folding from './features/folding';
import * as format from './features/format';
import * as hover from './features/hover';
import * as inlayHints from './features/inlayHints';
import * as navigation from './features/navigation';
import * as semanticTokens from './features/semanticTokens';
import * as signatureHelp from './features/signatureHelp';
import * as values from './features/values';
import { SettingsStore, type Settings } from './settings';

/** Every feature module. Each exports `register(ctx)`. */
const FEATURES: { name: string; register(ctx: ServerContext): void }[] = [
  { name: 'hover', ...hover },
  { name: 'completion', ...completion },
  { name: 'codeActions', ...codeActions },
  { name: 'navigation', ...navigation },
  { name: 'diagnostics', ...diagnostics },
  { name: 'signatureHelp', ...signatureHelp },
  { name: 'inlayHints', ...inlayHints },
  { name: 'semanticTokens', ...semanticTokens },
  { name: 'folding', ...folding },
  { name: 'colors', ...colors },
  { name: 'values', ...values },
  { name: 'format', ...format },
];

/** `.` members, `#` directives, `"` `<` `/` include paths. */
export const COMPLETION_TRIGGERS = ['.', '#', '"', '/', '<'];

/** Custom request: re-scan the workspace (command glslLsp.reindex). */
export const REINDEX_REQUEST = 'glslLsp/reindex';

/**
 * Custom notification from the client: facts about the editor that the
 * settings do not carry. Also accepted in `initializationOptions`.
 */
export const CLIENT_ENVIRONMENT_NOTIFICATION = 'glslLsp/clientEnvironment';
export interface ClientEnvironment {
  /** The stevensona.shader-toy extension is installed (glslLsp.shadertoy.enable 'auto' then applies Shadertoy everywhere). */
  shaderToyInstalled?: boolean;
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const settings = new SettingsStore();
// Own instance: setEnvironment adds the configured uniforms and defines to it.
const builtins = new Builtins(builtinData);
const workspace = new Workspace({ fs: new NodeFileSystem(), builtins });

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let indexed = false;
const indexedListeners = new Set<() => void>();
const environmentListeners = new Set<(reason: 'settings' | 'client') => void>();

function environmentChanged(reason: 'settings' | 'client') {
  for (const l of environmentListeners) l(reason);
}

const log: Logger = {
  error: (m) => connection.console.error(m),
  warn: (m) => connection.console.warn(m),
  info: (m) => connection.console.info(m),
  debug: (m) => {
    if (settings.get().trace.server === 'verbose') connection.console.log(m);
  },
};

const ctx: ServerContext = {
  connection,
  documents,
  workspace,
  builtins,
  settings,
  log,
  getModel: (uri) => workspace.getModel(uri),
  getDocument: (uri) => documents.get(uri),
  onModelChanged: (listener) => workspace.onDidChangeModel(listener),
  onEnvironmentChanged: (listener) => {
    environmentListeners.add(listener);
    return { dispose: () => environmentListeners.delete(listener) };
  },
  onIndexed: (listener) => {
    indexedListeners.add(listener);
    return { dispose: () => indexedListeners.delete(listener) };
  },
  get indexed() {
    return indexed;
  },
  clientCapabilities: { snippetSupport: false, markdown: true, workDoneProgress: false, semanticTokensRefresh: false, inlayHintRefresh: false },
};

function applySettings(s: Settings) {
  workspace.configure({
    includePaths: s.includePaths,
    exclude: s.index.exclude,
    maxFiles: s.index.maxFiles,
    shadertoy: s.shadertoy.enable,
  });
  builtins.setEnvironment(s.environment);
}

function applyClientEnvironment(env: ClientEnvironment | undefined): boolean {
  if (typeof env?.shaderToyInstalled !== 'boolean' || env.shaderToyInstalled === workspace.shaderToyExtension) return false;
  workspace.configure({ shaderToyExtension: env.shaderToyInstalled });
  log.info(`shader-toy extension ${env.shaderToyInstalled ? 'installed' : 'not installed'}`);
  return true;
}

async function pullSettings() {
  if (!hasConfigurationCapability) return;
  try {
    const raw = await connection.workspace.getConfiguration('glslLsp');
    settings.update(raw);
  } catch (err) {
    log.warn(`could not read settings: ${(err as Error).message}`);
  }
}

async function indexWorkspace() {
  const progress = ctx.clientCapabilities.workDoneProgress ? await connection.window.createWorkDoneProgress() : undefined;
  progress?.begin('Indexing GLSL files', 0, undefined, false);
  try {
    const stats = await workspace.indexWorkspace((done, total) => progress?.report(Math.round((done / total) * 100), `${done}/${total}`));
    log.info(`Indexed ${stats.files} GLSL files in ${stats.ms} ms (${workspace.workspaceRoots.length} folder(s)).`);
  } catch (err) {
    log.error(`Indexing failed: ${(err as Error).stack ?? err}`);
  } finally {
    progress?.done();
  }
  indexed = true;
  for (const l of indexedListeners) l();
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const caps = params.capabilities;
  hasConfigurationCapability = !!caps.workspace?.configuration;
  hasWorkspaceFolderCapability = !!caps.workspace?.workspaceFolders;
  ctx.clientCapabilities.snippetSupport = !!caps.textDocument?.completion?.completionItem?.snippetSupport;
  ctx.clientCapabilities.workDoneProgress = !!caps.window?.workDoneProgress;
  ctx.clientCapabilities.semanticTokensRefresh = !!caps.workspace?.semanticTokens?.refreshSupport;
  ctx.clientCapabilities.inlayHintRefresh = !!caps.workspace?.inlayHint?.refreshSupport;
  const formats = caps.textDocument?.hover?.contentFormat;
  ctx.clientCapabilities.markdown = !formats || formats.includes('markdown');

  const roots = params.workspaceFolders?.map((f) => f.uri) ?? (params.rootUri ? [params.rootUri] : []);
  workspace.configure({ roots });
  const initOptions = params.initializationOptions as ({ settings?: unknown } & ClientEnvironment) | undefined;
  if (initOptions?.settings) settings.update(initOptions.settings);
  applySettings(settings.get());
  applyClientEnvironment(initOptions);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      completionProvider: {
        triggerCharacters: COMPLETION_TRIGGERS,
        resolveProvider: true,
      },
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [',', ')'] },
      definitionProvider: true,
      declarationProvider: true,
      typeDefinitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentHighlightProvider: true,
      documentSymbolProvider: { label: 'GLSL' },
      workspaceSymbolProvider: true,
      documentLinkProvider: { resolveProvider: false },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Refactor, CodeActionKind.Source],
      },
      inlayHintProvider: { resolveProvider: false },
      semanticTokensProvider: { legend: semanticTokensLegend, full: true, range: true },
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      colorProvider: true,
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentOnTypeFormattingProvider: { firstTriggerCharacter: format.ON_TYPE_FIRST_TRIGGER, moreTriggerCharacter: format.ON_TYPE_MORE_TRIGGERS },
      workspace: hasWorkspaceFolderCapability ? { workspaceFolders: { supported: true, changeNotifications: true } } : undefined,
    },
    serverInfo: { name: 'glsl-lsp', version: '0.4.0' },
  };
});

connection.onInitialized(async () => {
  if (hasConfigurationCapability) {
    void connection.client.register(DidChangeConfigurationNotification.type, { section: 'glslLsp' });
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(async (e) => {
      const roots = new Set(workspace.workspaceRoots);
      for (const r of e.removed) roots.delete(normalizeUri(r.uri));
      for (const a of e.added) roots.add(normalizeUri(a.uri));
      workspace.configure({ roots: [...roots] });
      await indexWorkspace();
    });
  }
  await pullSettings();
  await indexWorkspace();
});

settings.onDidChange((s, prev) => {
  applySettings(s);
  // A different exclude list or file cap changes what is indexed: re-index (drops files that are now excluded).
  const indexChanged = s.index.maxFiles !== prev.index.maxFiles || JSON.stringify(s.index.exclude) !== JSON.stringify(prev.index.exclude);
  if (indexed && indexChanged) void indexWorkspace();
  const envChanged = s.shadertoy.enable !== prev.shadertoy.enable || JSON.stringify(s.environment) !== JSON.stringify(prev.environment);
  if (envChanged) environmentChanged('settings');
});

connection.onNotification(CLIENT_ENVIRONMENT_NOTIFICATION, (env: ClientEnvironment) => {
  if (applyClientEnvironment(env)) environmentChanged('client');
});

connection.onDidChangeConfiguration(async (change) => {
  if (hasConfigurationCapability) await pullSettings();
  else settings.update((change.settings as { glslLsp?: unknown } | undefined)?.glslLsp);
});

documents.onDidChangeContent((e) => {
  workspace.updateDocument(e.document.uri, e.document.getText(), e.document.version);
});

documents.onDidClose((e) => {
  workspace.closeDocument(e.document.uri);
});

connection.onDidChangeWatchedFiles((params) => {
  for (const change of params.changes) {
    if (change.type === FileChangeType.Deleted) workspace.fileDeleted(change.uri);
    else if (change.type === FileChangeType.Created) workspace.fileCreated(change.uri);
    else workspace.fileChanged(change.uri);
  }
});

connection.onRequest(REINDEX_REQUEST, async () => {
  await indexWorkspace();
  return { files: workspace.size };
});

for (const feature of FEATURES) {
  try {
    feature.register(ctx);
  } catch (err) {
    log.error(`feature '${feature.name}' failed to register: ${(err as Error).stack ?? err}`);
  }
}

process.on('uncaughtException', (err) => log.error(`uncaught: ${err.stack ?? err}`));
process.on('unhandledRejection', (err) => log.warn(`unhandled rejection: ${(err as Error)?.stack ?? err}`));

documents.listen(connection);
connection.listen();
