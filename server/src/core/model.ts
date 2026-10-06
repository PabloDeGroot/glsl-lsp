// The data model produced by `parse()` (see parser.ts). Everything here is
// plain data: no VS Code types, no file system access. Ranges are LSP-shaped
// (see text.ts); offsets are absolute UTF-16 offsets into `FileModel.text`.
//
// Stability: feature code depends on these shapes. Add fields freely; rename
// or remove only together with every user (grep server/src/features).

import type { Token } from './lexer';
import type { LineIndex, Range } from './text';

// ---------------------------------------------------------------- doc comments

export type DocStyle = 'line' | 'block' | 'yaml';

/** A documentation comment attached to a declaration or a file. */
export interface DocComment {
  /**
   * 'line'  contiguous // comments,
   * 'block' a /* *\/ or /** *\/ comment,
   * 'yaml'  a LYGIA-style block with `description:`/`use:` keys.
   */
  style: DocStyle;
  /** Comment text with comment markers and common indentation removed. */
  text: string;
  /** Parsed keys for 'yaml' docs (lower-cased key names). */
  yaml?: YamlDoc;
  /** Range of the comment(s) in the source file. */
  range: Range;
  /** True when the doc came from the file-level LYGIA block rather than the declaration itself. */
  inherited?: boolean;
}

/** Key/value view of a LYGIA YAML-ish doc block. */
export interface YamlDoc {
  /** key -> scalar text (multi-line scalars joined with '\n'). */
  values: Record<string, string>;
  /** key -> list items (`- item` lines). */
  lists: Record<string, string[]>;
  /** Keys in source order. */
  keys: string[];
}

// ---------------------------------------------------------------- types & symbols

/** A type as written in source: `vec3`, `float[4]`, `Material`. */
export interface TypeRef {
  /** Base type name without array suffix. */
  name: string;
  /** Array suffix including brackets, e.g. `[4]` or `[]`, if any. */
  array?: string;
  /** Range of the type name in the source, when it came from source. */
  range?: Range;
}

export type SymbolKind =
  | 'function'
  | 'parameter'
  | 'variable'
  | 'struct'
  | 'field'
  | 'macro'
  | 'block'; // interface block: `uniform Name { ... } instance;`

/** Where a variable lives. */
export type VariableStorage = 'global' | 'local';

/** Which construct declared the symbol (for hover wording / semantic tokens). */
export type SymbolOrigin = 'declaration' | 'iUniform' | 'iChannel' | 'define';

interface SymbolBase {
  kind: SymbolKind;
  name: string;
  /** Document that declares the symbol. */
  uri: string;
  /** Full declaration range (signature + body for functions). */
  range: Range;
  /** Range of the declared name. */
  nameRange: Range;
  /** Offset of the name (fast comparisons; same point as nameRange.start). */
  nameOffset: number;
  doc?: DocComment;
  origin?: SymbolOrigin;
}

export interface ParameterSymbol extends SymbolBase {
  kind: 'parameter';
  type: TypeRef;
  /** `in`, `out`, `inout`, `const`, precision... in source order. */
  qualifiers: string[];
  /** Index in the parameter list. */
  index: number;
  /** Unnamed prototype parameter (`float f(float);`) gets name ''. */
}

export interface FunctionSymbol extends SymbolBase {
  kind: 'function';
  returnType: TypeRef;
  /** Qualifiers before the return type (`highp`, `precise`, ...). */
  qualifiers: string[];
  params: ParameterSymbol[];
  /** True for a prototype (`float f(float x);`) without a body. */
  isPrototype: boolean;
  /** Range of `(...)`, including the parentheses. */
  paramsRange: Range;
  /** Range of the `{ ... }` body, if any. */
  bodyRange?: Range;
  /** Scope of the body (parameters live here). */
  scope?: Scope;
}

export interface VariableSymbol extends SymbolBase {
  kind: 'variable';
  type: TypeRef;
  qualifiers: string[];
  storage: VariableStorage;
  /** `layout(...)` text, if any. */
  layout?: string;
  /** Source text of the initializer expression, if any. */
  initializer?: string;
  /** Range of the initializer expression, if any. */
  initializerRange?: Range;
  /**
   * Offset from which the name is in scope: the end of the initializer, or
   * the end of the declarator when there is none (GLSL 4.2.2: `float d = d;`
   * reads the outer `d`). Undefined for symbols not made by a declarator.
   */
  visibleFrom?: number;
  /** For `#iUniform` directives: slider range and default. */
  iUniform?: IUniformInfo;
  /** For `#iChannelN` directives: the channel index and source. */
  iChannel?: { index: number; source: string };
}

export interface IUniformInfo {
  /** Declared type as written: `float`, `color3`, `vec2`... */
  declaredType: string;
  defaultValue?: string;
  min?: string;
  max?: string;
  step?: string;
}

export interface FieldSymbol extends SymbolBase {
  kind: 'field';
  type: TypeRef;
  qualifiers: string[];
  /** Name of the struct or interface block that owns this field. */
  parent: string;
  /** Identity of the owner when its name is not unique (`@<nameOffset>` for structs declared inside functions). */
  parentKey?: string;
}

export interface StructSymbol extends SymbolBase {
  kind: 'struct';
  fields: FieldSymbol[];
  /** Range of the `{ ... }` body. */
  bodyRange?: Range;
  /** Declared inside a function (two functions may declare different structs of one name). */
  local?: boolean;
}

export interface BlockSymbol extends SymbolBase {
  kind: 'block';
  /** Storage qualifier: uniform, buffer, in, out. */
  qualifiers: string[];
  layout?: string;
  fields: FieldSymbol[];
  /** Instance name (`} ubo;`), if any. Without one, fields are global names. */
  instanceName?: string;
  bodyRange?: Range;
}

export interface MacroSymbol extends SymbolBase {
  kind: 'macro';
  /** Parameter names for function-like macros; undefined for object-like. */
  params?: string[];
  /** Replacement text (continuations joined, comments stripped). */
  body: string;
  /** Heuristic: an empty `#define FNC_X` right after `#ifndef FNC_X`. */
  isIncludeGuard: boolean;
}

export type GlslSymbol =
  | FunctionSymbol
  | ParameterSymbol
  | VariableSymbol
  | StructSymbol
  | FieldSymbol
  | MacroSymbol
  | BlockSymbol;

/** Symbols that can be visible outside their declaring file. */
export type GlobalSymbol = FunctionSymbol | VariableSymbol | StructSymbol | MacroSymbol | BlockSymbol;

// ---------------------------------------------------------------- scopes

export type ScopeKind = 'file' | 'function' | 'block' | 'for';

export interface Scope {
  kind: ScopeKind;
  /** Offset range [start, end] covered by the scope. */
  start: number;
  end: number;
  range: Range;
  parent?: Scope;
  children: Scope[];
  /** Locals and parameters declared directly in this scope (file scope: empty, see FileModel). */
  symbols: (VariableSymbol | ParameterSymbol | StructSymbol)[];
  /** The function owning a 'function' scope. */
  function?: FunctionSymbol;
}

// ---------------------------------------------------------------- occurrences & calls

export type OccurrenceRole =
  | 'declaration' // the name in a declaration
  | 'reference' // plain identifier use
  | 'call' // identifier immediately followed by `(`
  | 'member' // identifier after `.` (field or swizzle)
  | 'type' // identifier used as a type name (user struct or macro type)
  | 'directive'; // identifier inside a preprocessor directive (#ifdef X, #define bodies)

/** Every identifier the parser saw, in source order. */
export interface Occurrence {
  name: string;
  role: OccurrenceRole;
  start: number;
  end: number;
  range: Range;
  /** For 'declaration': the declared symbol. */
  symbol?: GlslSymbol;
  /** For 'member': index (into FileModel.occurrences) of the receiver occurrence, if it was simple. */
  receiver?: number;
  /** For 'call': index into FileModel.calls. */
  call?: number;
}

/** A call or constructor expression `name(args...)`. Unclosed calls are kept (cursor mid-typing). */
export interface CallSite {
  /** Callee name: a function, macro, builtin, struct or basic type (constructor). */
  name: string;
  nameRange: Range;
  /** Offset of `(`. */
  openParen: number;
  /** Offset of `)`, or undefined if the call is not closed yet. */
  closeParen?: number;
  /** From the name to `)` (or to where parsing stopped). */
  range: Range;
  /** Ranges of each argument expression (trimmed). Empty for `f()`. */
  args: Range[];
  /** Offsets of the separating commas. */
  commas: number[];
  /** True when `name` is a basic type keyword (`vec3(...)`). */
  isConstructor: boolean;
  /** Index into FileModel.occurrences of the callee name (undefined for keyword constructors). */
  occurrence?: number;
}

// ---------------------------------------------------------------- directives

export type DirectiveKind =
  | 'include'
  | 'define'
  | 'undef'
  | 'if'
  | 'ifdef'
  | 'ifndef'
  | 'elif'
  | 'else'
  | 'endif'
  | 'version'
  | 'extension'
  | 'pragma'
  | 'line'
  | 'error'
  | 'iChannel'
  | 'iUniform'
  | 'iKeyboard'
  | 'other';

export interface Directive {
  kind: DirectiveKind;
  /** Directive name as written, without '#': `include`, `iChannel0::WrapMode`... */
  name: string;
  /** Text after the name (trimmed). */
  args: string;
  /** Whole directive range. */
  range: Range;
  start: number;
  end: number;
  /** Index of the directive token in FileModel.tokens. */
  tokenIndex: number;
}

export interface IncludeDirective {
  /** Path text inside the quotes (or angle brackets). */
  path: string;
  /** Range of the path text, without quotes. */
  pathRange: Range;
  /** Range of the whole `#include "..."` line. */
  range: Range;
  /** Filled by the Workspace: resolved document URI, or undefined if not found. */
  resolvedUri?: string;
}

/** A `#if/#ifdef/#ifndef ... #endif` group. */
export interface ConditionalBlock {
  /** The opening directive and every #elif/#else, then #endif (if present). */
  branches: Directive[];
  endif?: Directive;
  /** Macro named by #ifdef/#ifndef, if any. */
  macro?: string;
}

export interface ShadertoyInfo {
  /** `#iChannelN "source"` directives (not the ::Option ones). */
  channels: { index: number; source: string; range: Range }[];
  /** True when the file declares `#iKeyboard`. */
  keyboard: boolean;
  /** Contains `mainImage`. */
  hasMainImage: boolean;
}

// ---------------------------------------------------------------- folding

export type FoldKind = 'comment' | 'imports' | 'region' | 'code';

export interface FoldRegion {
  startLine: number;
  endLine: number;
  kind: FoldKind;
}

/** A matched `(`/`[`/`{` pair; `close` is undefined when unmatched. */
export interface BracketPair {
  open: number;
  close?: number;
  char: '(' | '[' | '{';
}

// ---------------------------------------------------------------- the file

export interface ParseIssue {
  message: string;
  range: Range;
}

export interface FileModel {
  uri: string;
  /** Document version for open buffers; undefined for files read from disk. */
  version?: number;
  text: string;
  lines: LineIndex;
  /** Every token including comments and directives, in source order. */
  tokens: Token[];

  directives: Directive[];
  includes: IncludeDirective[];
  conditionals: ConditionalBlock[];
  /** `#version` number, e.g. 300, if declared. */
  glslVersion?: { number: number; profile?: string; range: Range };
  shadertoy: ShadertoyInfo;

  /** Top-level (file scope) symbols in source order: functions, globals, structs, blocks, macros, #iUniforms. */
  symbols: GlobalSymbol[];
  functions: FunctionSymbol[];
  structs: StructSymbol[];
  /** Global variables incl. uniforms, consts, in/out, #iUniform, #iChannel. */
  globals: VariableSymbol[];
  macros: MacroSymbol[];
  blocks: BlockSymbol[];

  /** File scope; function and block scopes hang below it. */
  rootScope: Scope;
  /** Identifier occurrences sorted by offset. */
  occurrences: Occurrence[];
  calls: CallSite[];

  /** File header doc: the LYGIA YAML block, or a leading comment. */
  fileDoc?: DocComment;
  folding: FoldRegion[];
  brackets: BracketPair[];
  /** Soft syntax problems noticed while parsing (never thrown). */
  issues: ParseIssue[];
}
