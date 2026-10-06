// Formatter options: the editor's LSP FormattingOptions merged with the
// glslLsp.format.* settings, sanitized so the rest of the formatter never has
// to check them again.

export type FormatMode = 'conservative' | 'opinionated' | 'off';
export type BraceStyle = 'preserve' | 'sameLine' | 'nextLine';

/** The glslLsp.format.* settings. */
export interface FormatSettings {
  mode: FormatMode;
  maxBlankLines: number;
  braceStyle: BraceStyle;
  indentPreprocessor: boolean;
}

/** The subset of LSP `FormattingOptions` the formatter reads. */
export interface EditorFormattingOptions {
  tabSize?: number;
  insertSpaces?: boolean;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  trimFinalNewlines?: boolean;
}

export interface FormatOptions {
  mode: FormatMode;
  tabSize: number;
  insertSpaces: boolean;
  /** One indentation level: `tabSize` spaces or a tab. */
  unit: string;
  /** Visual width of one level. */
  unitWidth: number;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  trimFinalNewlines: boolean;
  maxBlankLines: number;
  braceStyle: BraceStyle;
  indentPreprocessor: boolean;
}

export const defaultFormatSettings: FormatSettings = {
  mode: 'conservative',
  maxBlankLines: 1,
  braceStyle: 'preserve',
  indentPreprocessor: false,
};

/**
 * Merges editor options over the settings. The three optional LSP flags
 * default to true: they are formatter rules, and only an explicit `false`
 * turns one off.
 */
export function resolveFormatOptions(editor: EditorFormattingOptions | undefined, settings: Partial<FormatSettings> | undefined): FormatOptions {
  const s = { ...defaultFormatSettings, ...(settings ?? {}) };
  const e = editor ?? {};
  const tab = Number.isFinite(e.tabSize) ? Math.round(e.tabSize as number) : 4;
  const tabSize = Math.min(16, Math.max(1, tab));
  const insertSpaces = e.insertSpaces !== false;
  const maxBlank = Number.isFinite(s.maxBlankLines) ? Math.max(0, Math.floor(s.maxBlankLines)) : 1;
  return {
    mode: ['conservative', 'opinionated', 'off'].includes(s.mode) ? s.mode : 'conservative',
    tabSize,
    insertSpaces,
    unit: insertSpaces ? ' '.repeat(tabSize) : '\t',
    unitWidth: tabSize,
    trimTrailingWhitespace: e.trimTrailingWhitespace !== false,
    insertFinalNewline: e.insertFinalNewline !== false,
    trimFinalNewlines: e.trimFinalNewlines !== false,
    maxBlankLines: maxBlank,
    braceStyle: ['preserve', 'sameLine', 'nextLine'].includes(s.braceStyle) ? s.braceStyle : 'preserve',
    indentPreprocessor: s.indentPreprocessor === true,
  };
}
