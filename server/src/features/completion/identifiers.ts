// Identifier completion: locals, this file, included files, builtins,
// keywords/types, and symbols from files that are not included yet
// (auto-include: selecting one adds the `#include` line).

import { CompletionItemKind, InsertTextFormat, type CompletionItem } from 'vscode-languageserver/node';
import {
  BASIC_TYPES,
  CONTROL_KEYWORDS,
  formatDocMarkdown,
  OTHER_KEYWORDS,
  QUALIFIERS,
  scopeAt,
  tokenIndexAt,
  type FileModel,
  type GlobalSymbol,
  type GlslSymbol,
  type Token,
} from '../../core';
import { IncludeContext, isAutoIncludable } from '../autoInclude';
import {
  applyCallInsert,
  builtinDetail,
  builtinKind,
  builtinParamsLabel,
  deprecatedTags,
  paramsLabel,
  symbolDetail,
  symbolKind,
} from './items';
import { Rank, sortText, type CompletionData, type CompletionEnv } from './types';

/** Max not-yet-included items per request (the list is re-requested while typing). */
export const MAX_WORKSPACE_ITEMS = 300;
/** Max include candidates offered per name. */
const MAX_CANDIDATES_PER_NAME = 3;

export interface IdentifierResult {
  items: CompletionItem[];
  /** True when the list depends on the typed prefix (auto-include items were filtered/capped). */
  isIncomplete: boolean;
}

export interface IdentifierOptions {
  word: string;
  wordStart: number;
  offset: number;
  /** In a #define body: no locals, no auto-include. */
  inDirective: boolean;
}

function isUpperCamelBoundary(name: string, i: number): boolean {
  const c = name.charAt(i);
  const p = name.charAt(i - 1);
  return c >= 'A' && c <= 'Z' && !(p >= 'A' && p <= 'Z');
}

/**
 * Prefix filter for not-yet-included symbols, mirroring how editors fuzzy
 * match: the first typed character must start a word in the name (start,
 * after `_`/digit, camelCase hump), the rest is a case-insensitive subsequence.
 * Returns a score (lower is better) or -1.
 */
export function matchScore(name: string, word: string): number {
  if (!word) return 0;
  const lname = name.toLowerCase();
  const lword = word.toLowerCase();
  if (lname.startsWith(lword)) return name.startsWith(word) ? 0 : 1;
  const first = lword.charAt(0);
  for (let i = 0; i < name.length; i++) {
    if (lname.charAt(i) !== first) continue;
    const boundary = i === 0 || !/[A-Za-z]/.test(name.charAt(i - 1)) || isUpperCamelBoundary(name, i);
    if (!boundary) continue;
    let j = i + 1;
    let k = 1;
    while (k < lword.length && j < lname.length) {
      if (lname.charAt(j) === lword.charAt(k)) k++;
      j++;
    }
    if (k === lword.length) return 2 + i;
  }
  return -1;
}

export function identifierCompletions(env: CompletionEnv, model: FileModel, opts: IdentifierOptions): IdentifierResult {
  const ws = env.workspace;
  const uri = model.uri;
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const text = model.text;
  const parenFollows = /^\w*[ \t]*\(/.test(text.slice(opts.offset));

  // ---- locals and parameters
  const visible = ws.visibleSymbols(uri, model.lines.positionAt(opts.offset));
  // Naming a new variable, parameter or field (`float gno|`): nothing to complete,
  // and accepting a library symbol would add an unrelated #include.
  if (!opts.inDirective && isDeclaratorName(model, opts.wordStart, visible)) return { items: [], isIncomplete: false };
  if (!opts.inDirective) {
    for (const s of visible.locals) {
      if (s.nameOffset === opts.wordStart || !s.name || seen.has(s.name)) continue;
      seen.add(s.name);
      const doc = formatDocMarkdown(s.doc);
      items.push({
        label: s.name,
        kind: symbolKind(s),
        detail: symbolDetail([s]),
        sortText: sortText(Rank.local, s.name),
        documentation: doc ? { kind: 'markdown', value: doc } : undefined,
      });
    }
  }

  // ---- top-level symbols of this file and its includes (overloads merged)
  const groups = new Map<string, GlslSymbol[]>();
  for (const s of visible.globals) {
    if (!s.name || (s.kind === 'macro' && s.isIncludeGuard)) continue;
    if (s.uri === uri && s.nameOffset === opts.wordStart) continue; // the word being typed
    if (s.kind === 'function' && s.name === 'mainImage') continue;
    const key = s.kind === 'block' ? '\0block:' + s.name : s.name;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(s);
    if (s.kind === 'block' && s.instanceName && !groups.has(s.instanceName)) groups.set(s.instanceName, [s]);
  }
  for (const [key, group] of groups) {
    if (key.startsWith('\0')) continue; // block type names are not useful as expressions
    if (seen.has(key)) continue;
    seen.add(key);
    const first = group[0];
    if (first.kind === 'block') {
      // Instance name of an interface block.
      items.push({ label: key, kind: CompletionItemKind.Variable, detail: symbolDetail([first]), sortText: sortText(first.uri === uri ? Rank.file : Rank.included, key) });
      continue;
    }
    const local = first.uri === uri;
    const item: CompletionItem = {
      label: key,
      kind: symbolKind(first),
      detail: symbolDetail(group),
      sortText: sortText(local ? Rank.file : Rank.included, key),
      data: { k: 'g', u: uri, n: key, f: first.uri } satisfies CompletionData,
    };
    const params = paramsLabel(group);
    const description = local ? undefined : ws.displayPath(first.uri);
    if (params || description) item.labelDetails = { detail: params, description };
    if (first.kind === 'function' || (first.kind === 'macro' && first.params)) {
      const hasParams = group.some((s) => (s.kind === 'function' && s.params.length > 0) || (s.kind === 'macro' && !!s.params?.length));
      if (!opts.inDirective) applyCallInsert(item, key, hasParams, env, parenFollows);
    }
    items.push(item);
  }
  for (const f of visible.blockFields) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    items.push({ label: f.name, kind: CompletionItemKind.Field, detail: symbolDetail([f]), sortText: sortText(f.uri === uri ? Rank.file : Rank.included, f.name) });
  }

  // ---- builtins
  const builtins = ws.builtins;
  const filter = ws.builtinFilter(model);
  const atFileScope = scopeAt(model, opts.offset).kind === 'file';
  for (const fn of builtins.allFunctions(filter)) {
    if (seen.has(fn.name)) continue;
    const snippet = 'snippet' in fn && typeof fn.snippet === 'string' ? fn.snippet : undefined;
    // Entry points (`mainImage`...) only make sense as a definition at file scope.
    if (fn.category === 'entrypoint' && (!atFileScope || opts.inDirective)) continue;
    seen.add(fn.name);
    const item: CompletionItem = {
      label: fn.name,
      kind: CompletionItemKind.Function,
      detail: builtinDetail(fn),
      sortText: sortText(Rank.builtin, fn.name),
      tags: deprecatedTags(fn),
      labelDetails: { detail: builtinParamsLabel(fn) },
      data: { k: 'b', u: uri, n: fn.name } satisfies CompletionData,
    };
    if (snippet && atFileScope && env.snippetSupport) {
      item.insertText = snippet;
      item.insertTextFormat = InsertTextFormat.Snippet;
      item.kind = CompletionItemKind.Snippet;
    } else if (!opts.inDirective) applyCallInsert(item, fn.name, fn.overloads.some((o) => o.params.length > 0), env, parenFollows);
    items.push(item);
  }
  for (const v of builtins.allVariables(filter)) {
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    items.push({
      label: v.name,
      kind: builtinKind(v),
      detail: builtinDetail(v),
      sortText: sortText(Rank.builtin, v.name),
      tags: deprecatedTags(v),
      data: { k: 'b', u: uri, n: v.name } satisfies CompletionData,
    });
  }
  for (const m of builtins.macros.values()) {
    if (seen.has(m.name) || !builtins.passes(m, filter)) continue;
    seen.add(m.name);
    items.push({ label: m.name, kind: CompletionItemKind.Constant, detail: builtinDetail(m), sortText: sortText(Rank.builtin, m.name), data: { k: 'b', u: uri, n: m.name } satisfies CompletionData });
  }

  // ---- types and keywords (builtin data first for docs/snippets, then the core word sets)
  for (const t of builtins.types.values()) {
    if (seen.has(t.name) || !builtins.passes(t, filter)) continue;
    seen.add(t.name);
    items.push({ label: t.name, kind: CompletionItemKind.Class, detail: 'type', sortText: sortText(Rank.keyword, t.name), data: { k: 'b', u: uri, n: t.name } satisfies CompletionData });
  }
  for (const name of BASIC_TYPES) {
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({ label: name, kind: CompletionItemKind.Class, detail: 'type', sortText: sortText(Rank.keyword, name) });
  }
  if (!opts.inDirective) {
    for (const k of builtins.keywords.values()) {
      if (seen.has(k.name)) continue;
      seen.add(k.name);
      const item: CompletionItem = {
        label: k.name,
        kind: CompletionItemKind.Keyword,
        detail: builtinDetail(k),
        sortText: sortText(Rank.keyword, k.name),
        data: { k: 'b', u: uri, n: k.name } satisfies CompletionData,
      };
      if (k.snippet && env.snippetSupport) {
        item.insertText = k.snippet;
        item.insertTextFormat = InsertTextFormat.Snippet;
      }
      items.push(item);
    }
    for (const set of [QUALIFIERS, CONTROL_KEYWORDS, OTHER_KEYWORDS]) {
      for (const name of set) {
        if (seen.has(name)) continue;
        seen.add(name);
        items.push({ label: name, kind: CompletionItemKind.Keyword, detail: QUALIFIERS.has(name) ? 'qualifier' : 'keyword', sortText: sortText(Rank.keyword, name) });
      }
    }
  }

  // ---- symbols from files that are not included yet
  let isIncomplete = false;
  if (env.autoInclude && !opts.inDirective) {
    isIncomplete = true; // results depend on the typed prefix
    items.push(...workspaceCompletions(env, model, opts.word, seen, parenFollows));
  }
  return { items, isIncomplete };
}

/**
 * True when the word at `wordStart` names a new declaration: it follows a type
 * name (`float gno|`, `float |`), or it is a later declarator of a declaration
 * list (`float a, gno|`, `vec2 a = vec2(0), b|`).
 */
function isDeclaratorName(model: FileModel, wordStart: number, visible: { locals: GlslSymbol[]; globals: GlobalSymbol[] }): boolean {
  const tokens = model.tokens;
  const isComment = (t: Token | undefined) => t?.kind === 'lineComment' || t?.kind === 'blockComment';
  // Last significant token ending at or before wordStart (the cursor may sit in whitespace).
  let i = tokenIndexAt(tokens, wordStart);
  if (i < 0) {
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid].end <= wordStart) lo = mid + 1;
      else hi = mid - 1;
    }
    i = hi;
  }
  while (i >= 0 && tokens[i].end > wordStart) i--;
  while (i >= 0 && isComment(tokens[i])) i--;
  const prevSignificant = (k: number) => {
    let j = k - 1;
    while (j >= 0 && isComment(tokens[j])) j--;
    return j;
  };
  const isTypeName = (name: string) => {
    if (BASIC_TYPES.has(name)) return true;
    const isStruct = (s: GlslSymbol) => (s.kind === 'struct' || s.kind === 'block') && s.name === name;
    return visible.locals.some(isStruct) || visible.globals.some(isStruct);
  };
  const prev = tokens[i];
  if (!prev) return false;
  if (prev.kind === 'ident') {
    if (tokens[prevSignificant(i)]?.text === '.') return false;
    return isTypeName(prev.text);
  }
  if (prev.text !== ',') return false;
  // A comma: find the start of the statement (at bracket depth 0) and check it opens a declaration.
  let depth = 0;
  let k = i - 1;
  for (; k >= 0; k--) {
    const t = tokens[k];
    if (isComment(t) || t.kind === 'directive') continue;
    const c = t.text;
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      if (depth === 0) return false; // argument or parameter list
      depth--;
    } else if (depth === 0 && (c === ';' || c === '{' || c === '}')) break;
  }
  let j = k + 1;
  const next = () => {
    while (j < i && (isComment(tokens[j]) || tokens[j].kind === 'directive')) j++;
    return tokens[j];
  };
  let t = next();
  // Qualifiers, layout(...) and upper-case qualifier macros (HIGHP).
  while (t && j < i) {
    if (t.text === 'layout') {
      j++;
      let d = 0;
      for (; j < i; j++) {
        if (tokens[j].text === '(') d++;
        else if (tokens[j].text === ')' && --d === 0) {
          j++;
          break;
        }
      }
    } else if (QUALIFIERS.has(t.text) || (/^[A-Z][A-Z0-9_]*$/.test(t.text) && !isTypeName(t.text))) j++;
    else break;
    t = next();
  }
  if (!t || j >= i || t.kind !== 'ident' || !isTypeName(t.text)) return false;
  j++;
  // `float[2] a, b` arrays on the type.
  t = next();
  if (t?.text === '[') {
    let d = 0;
    for (; j < i; j++) {
      if (tokens[j].text === '[') d++;
      else if (tokens[j].text === ']' && --d === 0) {
        j++;
        break;
      }
    }
    t = next();
  }
  return !!t && j < i && t.kind === 'ident';
}

/** Folders whose functions are offered first on an empty prefix (Ctrl+Space). */
const LYGIA_CORE_RE = /(^|\/)lygia\/(generative|math|color|sdf|draw|space)\//;
const TEST_RE = /(^|\/)(test|tests|fixtures|__tests__|node_modules)(\/|$)/i;

/** Relevance of a declaring file for empty-prefix completion (lower is better). */
function fileRelevance(path: string): number {
  if (TEST_RE.test(path)) return 9;
  if (/^lib\//.test(path) || /(^|\/)lib\//.test(path)) return 0;
  if (LYGIA_CORE_RE.test(path)) return 1;
  if (/(^|\/)lygia\//.test(path)) return 2;
  return 3;
}

/** Max names considered on an empty prefix (each may yield a few candidates). */
const MAX_EMPTY_PREFIX_NAMES = 300;

/**
 * Items for symbols declared in files outside the current include closure, with the include edit attached.
 * With an empty `word` (Ctrl+Space) only functions and structs are offered, ranked by
 * file relevance (lib/ first, then core LYGIA folders, then shorter paths), capped.
 */
export function workspaceCompletions(env: CompletionEnv, model: FileModel, word: string, visibleNames: Set<string>, parenFollows = false): CompletionItem[] {
  const ws = env.workspace;
  // Collect matching names first (cheap), then compute candidates for the best ones.
  const byName = new Map<string, { score: number; symbols: GlobalSymbol[] }>();
  const relevance = new Map<string, number>();
  const pathScore = (uri: string) => {
    let r = relevance.get(uri);
    if (r === undefined) {
      const p = ws.displayPath(uri);
      r = fileRelevance(p) * 10_000 + Math.min(p.length, 9_999);
      relevance.set(uri, r);
    }
    return r;
  };
  for (const s of ws.allGlobalSymbols()) {
    if (visibleNames.has(s.name) || !isAutoIncludable(s)) continue;
    if (!word && s.kind !== 'function' && s.kind !== 'struct') continue;
    let entry = byName.get(s.name);
    if (!entry) {
      const score = word ? matchScore(s.name, word) : pathScore(s.uri);
      if (score < 0) continue;
      byName.set(s.name, (entry = { score, symbols: [] }));
    } else if (!word) entry.score = Math.min(entry.score, pathScore(s.uri));
    entry.symbols.push(s);
  }
  if (!byName.size) return [];
  let names = [...byName.entries()].sort((a, b) => a[1].score - b[1].score || a[0].length - b[0].length || a[0].localeCompare(b[0]));
  if (!word) names = names.slice(0, MAX_EMPTY_PREFIX_NAMES);

  const ctx = new IncludeContext(ws, model);
  const out: CompletionItem[] = [];
  let rank = 0;
  for (const [name, { score, symbols }] of names) {
    if (out.length >= MAX_WORKSPACE_ITEMS) break;
    // Empty prefix: keep the relevance order (lib/ first) in the list.
    const order = word ? String(Math.min(score, 9)) : 'r' + String(rank++).padStart(3, '0');
    const candidates = ctx.candidatesFor(name, symbols).slice(0, MAX_CANDIDATES_PER_NAME);
    candidates.forEach((c, i) => {
      const declared = symbols.filter((s) => s.uri === c.declaringUri);
      const first = declared[0];
      const edit = ctx.includeEdit(c.path);
      const item: CompletionItem = {
        label: name,
        kind: symbolKind(first),
        detail: symbolDetail(declared),
        labelDetails: { detail: paramsLabel(declared), description: c.path },
        // Score keeps exact-prefix matches first among not-included symbols.
        sortText: sortText(Rank.workspace, name, order + i),
        filterText: name,
        additionalTextEdits: edit ? [edit] : undefined,
        data: { k: 'g', u: model.uri, n: name, f: c.declaringUri, inc: c.path } satisfies CompletionData,
      };
      if (first.kind === 'function' || (first.kind === 'macro' && first.params)) {
        const hasParams = declared.some((s) => (s.kind === 'function' && s.params.length > 0) || (s.kind === 'macro' && !!s.params?.length));
        applyCallInsert(item, name, hasParams, env, parenFollows);
      }
      out.push(item);
    });
  }
  return out;
}
