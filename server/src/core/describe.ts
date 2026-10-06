// Markdown descriptions of resolved symbols: used by hover, and by completion
// item documentation. Kept independent of LSP types (returns strings).

import type { BuiltinEntry } from '../builtins/types';
import { formatDocMarkdown } from './docs';
import type { FileModel, GlslSymbol } from './model';
import type { Resolution } from './resolve';
import { formatBuiltinFunction, formatSymbol } from './signature';
import type { Workspace } from './workspace';

export interface DescribeOptions {
  /** The file the description is shown in (for "Defined in" and include hints). */
  fromUri?: string;
  /** Max overload signatures listed. */
  maxOverloads?: number;
}

function codeBlock(lines: string[]): string {
  return '```glsl\n' + lines.join('\n') + '\n```';
}

/** Link to a symbol's declaration with the workspace-relative path as text. */
export function definedInMarkdown(ws: Workspace, symbol: GlslSymbol): string {
  const line = symbol.nameRange.start.line + 1;
  return `Defined in [${ws.displayPath(symbol.uri)}:${line}](${symbol.uri}#L${line})`;
}

function kindLabel(ws: Workspace, s: GlslSymbol): string | undefined {
  switch (s.kind) {
    case 'parameter': {
      const owner = ws
        .getModel(s.uri)
        ?.functions.find((f) => f.params.includes(s));
      return owner ? `parameter of \`${owner.name}\`` : 'parameter';
    }
    case 'variable':
      if (s.origin === 'iUniform') {
        const u = s.iUniform!;
        const parts = ['shader-toy `#iUniform`'];
        if (u.min !== undefined) parts.push(`range ${u.min} … ${u.max}`);
        if (u.defaultValue) parts.push(`default ${u.defaultValue}`);
        if (u.declaredType !== s.type.name) parts.push(`GLSL type \`${s.type.name}\``);
        return parts.join(', ');
      }
      if (s.storage === 'local') return 'local variable';
      if (s.qualifiers.includes('uniform')) return 'uniform';
      if (s.qualifiers.includes('const')) return 'global constant';
      return 'global variable';
    case 'field':
      return `field of \`${s.parent}\``;
    case 'macro':
      return s.isIncludeGuard ? 'include guard' : s.params ? 'function-like macro' : 'macro';
    default:
      return undefined;
  }
}

/** Full Markdown for one or more candidate symbols (overloads), primary first. */
export function describeSymbols(ws: Workspace, symbols: GlslSymbol[], primary: GlslSymbol, options: DescribeOptions = {}): string {
  const max = options.maxOverloads ?? 8;
  const ordered = [primary, ...symbols.filter((s) => s !== primary)];
  const sameKind = ordered.filter((s) => s.kind === primary.kind);
  const shown = primary.kind === 'function' ? sameKind.slice(0, max) : [primary];
  const parts: string[] = [];
  const sigs = shown.map(formatSymbol);
  if (primary.kind === 'function' && sameKind.length > max) sigs.push(`// +${sameKind.length - max} more overloads`);
  parts.push(codeBlock(sigs));

  const label = kindLabel(ws, primary);
  if (label) parts.push(`*${label}*`);

  const doc = primary.doc ?? shown.find((s) => s.doc)?.doc;
  const docMd = formatDocMarkdown(doc);
  if (docMd) parts.push(docMd);

  const isLocal = primary.kind === 'parameter' || (primary.kind === 'variable' && primary.storage === 'local');
  if (!isLocal) {
    let where = definedInMarkdown(ws, primary);
    if (options.fromUri && primary.uri !== options.fromUri && !ws.isReachable(options.fromUri, primary.uri)) {
      where += ` · not included here (\`#include "${ws.includePathFor(options.fromUri, primary.uri)}"\`)`;
    }
    parts.push(where);
  }
  return parts.join('\n\n');
}

/** Markdown for a builtin function / variable / type / keyword. */
export function describeBuiltin(entry: BuiltinEntry, activeOverload?: number): string {
  const parts: string[] = [];
  switch (entry.kind) {
    case 'function': {
      const sigs = formatBuiltinFunction(entry);
      if (activeOverload !== undefined && sigs[activeOverload]) sigs.unshift(...sigs.splice(activeOverload, 1));
      parts.push(codeBlock(sigs));
      break;
    }
    case 'variable': {
      const q = entry.qualifiers?.length ? entry.qualifiers.join(' ') + ' ' : '';
      parts.push(codeBlock([`${q}${entry.type} ${entry.name}${entry.value !== undefined ? ' = ' + entry.value : ''}`]));
      break;
    }
    case 'type':
      parts.push(codeBlock([entry.name]));
      break;
    case 'macro':
      parts.push(codeBlock([`#define ${entry.name}${entry.value !== undefined ? ' ' + entry.value : ''}`]));
      break;
    case 'keyword':
      parts.push(codeBlock([entry.name]));
      break;
    case 'directive':
      parts.push(codeBlock(['#' + entry.name]));
      break;
  }
  const notes: string[] = [];
  if ('shadertoy' in entry && entry.shadertoy) notes.push('Shadertoy');
  if ('requiresDirective' in entry && entry.requiresDirective) notes.push(`needs \`#${entry.requiresDirective}\``);
  if ('minVersion' in entry && entry.minVersion) notes.push(`GLSL ${entry.minVersion}+`);
  if ('stages' in entry && entry.stages?.length) notes.push(entry.stages.join(', ') + ' shader');
  if ('deprecated' in entry && entry.deprecated) notes.push(`deprecated: ${entry.deprecated}`);
  parts.push(notes.length ? `*builtin · ${notes.join(' · ')}*` : '*builtin*');
  if (entry.doc) parts.push(entry.doc);
  if (entry.kind === 'function') {
    const params = entry.overloads[activeOverload ?? 0]?.params.filter((p) => p.doc) ?? [];
    if (params.length) parts.push(params.map((p) => `*@param* \`${p.name}\` ${p.doc}`).join('  \n'));
  }
  if ('docUrl' in entry && entry.docUrl) parts.push(`[Reference](${entry.docUrl})`);
  return parts.join('\n\n');
}

/** Markdown for any Resolution (the hover body). */
export function describeResolution(ws: Workspace, res: Resolution, fromUri?: string): string | undefined {
  switch (res.kind) {
    case 'symbol':
      return describeSymbols(ws, res.symbols, res.primary, { fromUri });
    case 'builtin': {
      let active: number | undefined;
      if (res.entry.kind === 'function' && res.call) {
        const n = res.call.args.length;
        const i = res.entry.overloads.findIndex((o) => o.params.length === n);
        if (i >= 0) active = i;
      }
      return describeBuiltin(res.entry, active);
    }
    case 'swizzle':
      return codeBlock([`${res.resultType ?? ''} ${res.name}`.trim()]) + `\n\n*swizzle of \`${res.receiverType ?? '?'}\`*`;
    case 'include': {
      if (!res.targetUri) return `**Unresolved include** \`${res.include.path}\``;
      const target = ws.getModel(res.targetUri);
      return describeFile(ws, res.targetUri, target);
    }
  }
}

export function describeFile(ws: Workspace, uri: string, model?: FileModel): string {
  const parts = [`**${ws.displayPath(uri)}**`];
  if (model?.fileDoc) parts.push(formatDocMarkdown(model.fileDoc));
  if (model) {
    const fns = [...new Set(model.functions.map((f) => f.name))];
    if (fns.length) parts.push(`Functions: ${fns.slice(0, 20).map((n) => '`' + n + '`').join(', ')}${fns.length > 20 ? ', …' : ''}`);
  }
  return parts.join('\n\n');
}
