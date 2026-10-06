// Documentation comments: finding them in the token stream, cleaning them,
// parsing LYGIA's YAML-ish blocks and rendering everything as Markdown.
//
// Association rules (see ARCHITECTURE.md):
//  - Above: contiguous comments ending on the line directly above the
//    declaration (a blank line breaks association). A comment that trails
//    code on its own line belongs to that code, not to what follows.
//  - Trailing: a comment on the same line after a variable / field /
//    parameter / macro declaration.
//  - File level: a LYGIA block (`description:` / `use:` keys) anywhere in
//    the file documents every function, struct and function-like macro of
//    the file that has no doc of its own. Option macros listed under
//    `options:` get their option line as doc.

import { isComment, type Token } from './lexer';
import type { DocComment, DocStyle, YamlDoc } from './model';
import type { LineIndex } from './text';

// ---------------------------------------------------------------- cleaning

const DECORATIVE_RE = /^[\s\-=*#_~+/.<>|]{3,}$/;

function dedent(lines: string[]): string[] {
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = /^[ \t]*/.exec(l)![0].length;
    if (m < min) min = m;
  }
  if (!isFinite(min) || min === 0) return lines;
  return lines.map((l) => l.slice(Math.min(min, /^[ \t]*/.exec(l)![0].length)));
}

function trimBlankEdges(lines: string[]): string[] {
  let s = 0;
  let e = lines.length;
  while (s < e && !lines[s].trim()) s++;
  while (e > s && !lines[e - 1].trim()) e--;
  return lines.slice(s, e);
}

/** Text of a single comment token without markers. Lines are dedented. */
export function commentText(token: Token): string {
  return cleanCommentLines([token]).join('\n');
}

function cleanCommentLines(tokens: Token[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'lineComment') {
      // `//`, `///`, `//!` all count; strip one optional space.
      let body = t.text.replace(/^\/\/[\/!]?/, '');
      body = body.replace(/\s+$/, '');
      out.push(body);
    } else if (t.kind === 'blockComment') {
      let body = t.text.replace(/^\/\*[*!]?/, '').replace(/\*\/$/, '');
      let lines = body.split(/\r\n|\r|\n/).map((l) => l.replace(/\s+$/, ''));
      // Javadoc style: every non-first line starts with ` * `.
      const rest = lines.slice(1).filter((l) => l.trim());
      if (rest.length && rest.every((l) => /^\s*\*/.test(l))) {
        lines = lines.map((l, i) => (i === 0 ? l : l.replace(/^\s*\* ?/, '')));
      }
      // The first line's indentation is relative to `/*`, so dedent the rest on its own.
      out.push(lines[0].trim(), ...dedent(lines.slice(1)));
    }
  }
  const cleaned = out.filter((l) => !DECORATIVE_RE.test(l));
  // Dedent ignoring the first line when it was glued to `/*`.
  return trimBlankEdges(dedent(cleaned));
}

// ---------------------------------------------------------------- YAML-ish

const YAML_KEY_RE = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*)|\s*)$/;

/** True when the cleaned comment text looks like a LYGIA doc block. */
export function isYamlDocText(text: string): boolean {
  return /^(description|use)\s*:/m.test(text) && /^[A-Za-z_][\w-]*\s*:/.test(text.trimStart());
}

function parseInlineList(value: string): string[] | undefined {
  const m = /^\[(.*)\]$/.exec(value.trim());
  if (!m) return undefined;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function parseYamlDoc(text: string): YamlDoc {
  const doc: YamlDoc = { values: {}, lists: {}, keys: [] };
  let key: string | undefined;
  let blockScalar = false;
  for (const raw of text.split('\n')) {
    const m = /^\S/.test(raw) ? YAML_KEY_RE.exec(raw) : null;
    if (m) {
      key = m[1].toLowerCase();
      if (!doc.keys.includes(key)) doc.keys.push(key);
      const value = (m[2] ?? '').trim();
      blockScalar = value === '|' || value === '>' || value === '|-' || value === '>-';
      const inline = parseInlineList(value);
      if (inline) doc.lists[key] = inline;
      else doc.values[key] = blockScalar ? '' : value;
      continue;
    }
    if (!key) continue;
    const trimmed = raw.trim();
    if (!trimmed) {
      if (doc.values[key]) doc.values[key] += '\n';
      continue;
    }
    const item = /^-\s+(.*)$/.exec(trimmed);
    if (item && !blockScalar) {
      (doc.lists[key] ??= []).push(item[1].trim());
      continue;
    }
    const list = doc.lists[key];
    if (list && list.length && !blockScalar) {
      list[list.length - 1] += ' ' + trimmed;
    } else {
      const prev = doc.values[key] ?? '';
      doc.values[key] = prev ? (prev.endsWith('\n') ? prev + trimmed : prev + (blockScalar ? '\n' : ' ') + trimmed) : trimmed;
    }
  }
  for (const k of Object.keys(doc.values)) doc.values[k] = doc.values[k].trim();
  return doc;
}

/** A LYGIA `options:` item: `NAME: text`, `NAME(TEX, UV): text`, optionally in backticks. */
const OPTION_ITEM_RE = /^`?([A-Za-z_]\w*)(\([^)]*\))?`?\s*(?::\s*(.*))?$/;

/** For an option macro listed in a LYGIA `options:` list, its description. */
export function optionDescription(yaml: YamlDoc, macroName: string): string | undefined {
  for (const item of yaml.lists['options'] ?? []) {
    const m = OPTION_ITEM_RE.exec(item);
    if (m && m[1] === macroName) return (m[3] ?? '').trim() || '(option)';
  }
  return undefined;
}

// ---------------------------------------------------------------- building DocComments

export function makeDoc(tokens: Token[], lines: LineIndex): DocComment | undefined {
  if (!tokens.length) return undefined;
  const cleaned = cleanCommentLines(tokens);
  const text = cleaned.join('\n');
  if (!text.trim()) return undefined;
  let style: DocStyle = tokens[0].kind === 'blockComment' ? 'block' : 'line';
  let yaml: YamlDoc | undefined;
  if (style === 'block' && isYamlDocText(text)) {
    style = 'yaml';
    yaml = parseYamlDoc(text);
  }
  return { style, text, yaml, range: lines.range(tokens[0].start, tokens[tokens.length - 1].end) };
}

/**
 * Comments directly above `tokens[index]` (no blank line in between, not
 * trailing other code). Returns the doc or undefined.
 */
export function docAbove(tokens: readonly Token[], index: number, lines: LineIndex): DocComment | undefined {
  const collected: Token[] = [];
  let expectLine = tokens[index]?.line;
  if (expectLine === undefined) return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const c = tokens[i];
    if (!isComment(c)) break;
    if (expectLine - c.endLine > 1) break;
    const prev = tokens[i - 1];
    if (prev && !isComment(prev) && prev.endLine === c.line) break; // trailing comment of earlier code
    collected.unshift(c);
    expectLine = c.line;
  }
  return makeDoc(collected, lines);
}

export type TrailingMode = 'variable' | 'parameter' | 'directive';

/**
 * A comment on the same line after the declaration whose last relevant token
 * is `tokens[index]`.
 *  - 'variable': skip anything up to and including `;` or `,` on that line.
 *  - 'parameter': skip only array suffix, `,` and `)`.
 *  - 'directive': the next token itself.
 */
export function trailingDoc(tokens: readonly Token[], index: number, lines: LineIndex, mode: TrailingMode): DocComment | undefined {
  const line = tokens[index]?.endLine;
  if (line === undefined) return undefined;
  let depth = 0;
  let afterSemicolon = false;
  for (let i = index + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.line !== line) return undefined;
    if (isComment(t)) {
      if (t.kind === 'blockComment' && t.endLine !== line) return undefined;
      return makeDoc([t], lines);
    }
    if (mode === 'directive') return undefined;
    if (t.kind === 'directive') return undefined;
    if (mode === 'parameter') {
      if (t.text === '[') depth++;
      else if (t.text === ']') depth--;
      else if (depth > 0 || t.text === ',' || t.text === ')') continue;
      else return undefined;
      continue;
    }
    // variable: only a comment right after the declaration's own `;` counts.
    if (afterSemicolon) return undefined;
    if (t.text === '{' || t.text === '}') return undefined;
    if (t.text === '(' || t.text === '[') depth++;
    else if (t.text === ')' || t.text === ']') depth--;
    else if (t.text === ';' && depth <= 0) afterSemicolon = true;
  }
  return undefined;
}

/** The file-level doc: a LYGIA YAML block anywhere, else the leading comment at the top of the file. */
export function findFileDoc(tokens: readonly Token[], lines: LineIndex): DocComment | undefined {
  for (const t of tokens) {
    if (t.kind === 'blockComment') {
      const doc = makeDoc([t], lines);
      if (doc?.style === 'yaml') return doc;
    }
  }
  // Leading comment run at the very top.
  const run: Token[] = [];
  for (let i = 0; i < tokens.length && isComment(tokens[i]); i++) {
    if (run.length && tokens[i].line - run[run.length - 1].endLine > 1) break;
    run.push(tokens[i]);
  }
  return makeDoc(run, lines);
}

// ---------------------------------------------------------------- @param tags

/** `@param name text` (or `name: text` in a YAML doc's params list) for a parameter. */
export function paramDoc(doc: DocComment | undefined, paramName: string): string | undefined {
  if (!doc || !paramName) return undefined;
  const re = new RegExp(`^\\s*[@\\\\]param(?:\\[\\w+\\])?\\s+${paramName}\\b[\\s:-]*(.*)$`, 'm');
  const m = re.exec(doc.text);
  if (m) return m[1].trim() || undefined;
  return undefined;
}

// ---------------------------------------------------------------- markdown

/** Escapes characters that would accidentally format prose. Backticks are kept. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([*_<])/g, '\\$1')
    .replace(/^(\s*)([#>])/gm, '$1\\$2');
}

const LIST_RE = /^\s*([-*+]|\d+[.)])\s+/;
const TAG_RE = /^\s*[@\\](param|return|returns|brief|note|see|deprecated|example)\b\s*(.*)$/;

/** Renders plain comment text as Markdown: paragraphs, lists, indented code. */
export function plainTextToMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let code: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(escapeMarkdown(para.join(' ')));
    para = [];
  };
  const flushCode = () => {
    if (code.length) out.push('```glsl\n' + dedent(code).join('\n') + '\n```');
    code = [];
  };
  for (const line of lines) {
    if (!line.trim()) {
      flushPara();
      flushCode();
      continue;
    }
    const tag = TAG_RE.exec(line);
    if (tag) {
      flushPara();
      flushCode();
      const name = tag[1] === 'returns' ? 'return' : tag[1];
      let rest = tag[2];
      if (name === 'param') {
        const m = /^(\w+)\s*[:-]?\s*(.*)$/.exec(rest);
        if (m) rest = '`' + m[1] + '` ' + escapeMarkdown(m[2]);
      } else rest = escapeMarkdown(rest);
      out.push(`*@${name}* ${rest}`.trimEnd());
      continue;
    }
    const indent = /^\s*/.exec(line)![0].length;
    if (LIST_RE.test(line) && indent < 2) {
      flushPara();
      flushCode();
      out.push(escapeMarkdown(line.trim()).replace(/^\\\*/, '*'));
      continue;
    }
    if (indent >= 2) {
      flushPara();
      code.push(line);
      continue;
    }
    flushCode();
    // Continuation of a list item stays on the list item.
    para.push(line.trim());
  }
  flushPara();
  flushCode();
  // Separate blocks with blank lines, but keep consecutive list items/tags tight.
  let md = '';
  for (let i = 0; i < out.length; i++) {
    if (i > 0) {
      const tight = /^([-*+]|\d+[.)]) /.test(out[i]) && /^([-*+]|\d+[.)]) /.test(out[i - 1]);
      const tags = out[i].startsWith('*@') && out[i - 1].startsWith('*@');
      md += tight ? '\n' : tags ? '  \n' : '\n\n';
    }
    md += out[i];
  }
  return md;
}

/** Renders a LYGIA YAML doc: description, usage block, options, examples; contributors de-emphasized, license dropped. */
export function yamlToMarkdown(yaml: YamlDoc): string {
  const parts: string[] = [];
  const description = yaml.values['description'];
  if (description) parts.push(plainTextToMarkdown(description));
  const use = [...(yaml.values['use'] ? [yaml.values['use']] : []), ...(yaml.lists['use'] ?? [])].filter(Boolean);
  if (use.length) parts.push('**Usage**\n```glsl\n' + use.join('\n') + '\n```');
  const options = yaml.lists['options'] ?? [];
  if (options.length) {
    parts.push(
      '**Options**\n' +
        options
          .map((o) => {
            const m = OPTION_ITEM_RE.exec(o);
            return m ? `- \`${m[1]}${m[2] ?? ''}\`${m[3] ? ': ' + escapeMarkdown(m[3]) : ''}` : `- ${escapeMarkdown(o)}`;
          })
          .join('\n'),
    );
  }
  const examples = [...(yaml.values['examples'] ? [yaml.values['examples']] : []), ...(yaml.lists['examples'] ?? [])];
  const links = examples.filter((e) => /^https?:\/\//.test(e));
  if (links.length) parts.push('**Examples**: ' + links.map((l, i) => `[${i + 1}](${l})`).join(' '));
  const contributors = yaml.lists['contributors'] ?? (yaml.values['contributors'] ? [yaml.values['contributors']] : []);
  if (contributors.length) parts.push(`*Contributors: ${escapeMarkdown(contributors.join(', '))}*`);
  return parts.join('\n\n');
}

/** Markdown for a doc comment of any style. */
export function formatDocMarkdown(doc: DocComment | undefined): string {
  if (!doc) return '';
  if (doc.style === 'yaml' && doc.yaml) return yamlToMarkdown(doc.yaml);
  return plainTextToMarkdown(doc.text);
}

/** One-line summary of a doc (first sentence / description), for completion detail or lists. */
export function docSummary(doc: DocComment | undefined, maxLength = 120): string {
  if (!doc) return '';
  let text = doc.style === 'yaml' && doc.yaml ? doc.yaml.values['description'] ?? '' : doc.text;
  text = text.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text);
  if (sentence && sentence[1].length >= 12) text = sentence[1];
  return text.length > maxLength ? text.slice(0, maxLength - 1).trimEnd() + '…' : text;
}
