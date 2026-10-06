// ServerContext: everything a feature needs, handed to each feature's
// `register(ctx)`. Features never create their own connection, documents or
// workspace; they use these.

import type { Connection, TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Builtins } from './builtins';
import type { FileModel, ModelChangeEvent, Workspace } from './core';
import type { SettingsStore } from './settings';

export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  /** Only printed when glslLsp.trace.server is 'verbose'. */
  debug(message: string): void;
}

export interface ServerContext {
  connection: Connection;
  /** Open text documents (incremental sync). */
  documents: TextDocuments<TextDocument>;
  /** The index: models, include graph, resolution. Kept in sync by server.ts. */
  workspace: Workspace;
  builtins: Builtins;
  settings: SettingsStore;
  log: Logger;
  /** Model for a document URI (open buffer or disk), parsed on demand. */
  getModel(uri: string): FileModel | undefined;
  /** Open TextDocument for a URI, if open. */
  getDocument(uri: string): TextDocument | undefined;
  /** Fires after a model was (re)parsed or removed; `affected` includes every includer. */
  onModelChanged(listener: (e: ModelChangeEvent) => void): { dispose(): void };
  /** Fires once the initial workspace index is complete. */
  onIndexed(listener: () => void): { dispose(): void };
  /** True once the initial workspace index is complete. */
  readonly indexed: boolean;
  /** Client capability flags features may need. */
  clientCapabilities: {
    snippetSupport: boolean;
    markdown: boolean;
    workDoneProgress: boolean;
    /** workspace/semanticTokens/refresh is supported. */
    semanticTokensRefresh: boolean;
    /** workspace/inlayHint/refresh is supported. */
    inlayHintRefresh: boolean;
  };
}
