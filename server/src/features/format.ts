// Formatting: textDocument/formatting, rangeFormatting and onTypeFormatting.
// The formatter itself is pure and lives in ./format/ (no vscode imports);
// this file only reads the document, the editor's FormattingOptions and the
// glslLsp.format.* settings. Mode 'off' answers with no edits.

import type { ServerContext } from '../context';
import { formatDocument, formatOnType, formatRange } from './format/index';

/** Format-on-type triggers: `}` (first), then `;` and a new line. */
export const ON_TYPE_FIRST_TRIGGER = '}';
export const ON_TYPE_MORE_TRIGGERS = [';', '\n'];

export function register(ctx: ServerContext): void {
  ctx.connection.onDocumentFormatting((params) => {
    try {
      const doc = ctx.getDocument(params.textDocument.uri);
      return doc ? formatDocument(doc.getText(), params.options, ctx.settings.get().format) : [];
    } catch (err) {
      ctx.log.error(`formatting failed: ${(err as Error).stack ?? err}`);
      return [];
    }
  });
  ctx.connection.onDocumentRangeFormatting((params) => {
    try {
      const doc = ctx.getDocument(params.textDocument.uri);
      return doc ? formatRange(doc.getText(), params.range, params.options, ctx.settings.get().format) : [];
    } catch (err) {
      ctx.log.error(`range formatting failed: ${(err as Error).stack ?? err}`);
      return [];
    }
  });
  ctx.connection.onDocumentOnTypeFormatting((params) => {
    try {
      const doc = ctx.getDocument(params.textDocument.uri);
      return doc ? formatOnType(doc.getText(), params.position, params.ch, params.options, ctx.settings.get().format) : [];
    } catch (err) {
      ctx.log.error(`on-type formatting failed: ${(err as Error).stack ?? err}`);
      return [];
    }
  });
}
