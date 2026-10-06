# Architecture

glsl-lsp is a VS Code extension (`client/`) that starts a language server
(`server/`) over IPC. The server is split into a **core** that knows GLSL
and knows nothing about VS Code, and thin **feature** modules that translate
core results into LSP responses.

```
client/src/extension.ts        LanguageClient, commands, file watcher
server/src/server.ts           connection, document sync, settings, capabilities, feature registration
server/src/context.ts          ServerContext handed to every feature
server/src/settings.ts         glslLsp.* settings (defaults + change event)
server/src/core/               pure GLSL knowledge, unit-testable, no vscode imports
server/src/builtins/           builtin functions/variables/types/keywords/directives data
server/src/features/<name>.ts  one file per LSP feature, each exports register(ctx)
syntaxes/, language-configuration.json   TextMate grammar and editor behaviour
test/                          vitest tests, test/fixtures/ on-disk projects
```

Build: `npm run build` bundles `client/src/extension.ts` -> `dist/client.js`
and `server/src/server.ts` -> `dist/server.js` with esbuild
(`scripts/build.mjs`). `npm run typecheck` runs tsc over everything,
`npm test` runs vitest.

## Principles

- **Never throw on user code.** The user is mid-edit when they ask for
  completion. Lexer and parser recover from anything; feature handlers catch
  and log.
- **Core is pure.** `server/src/core` must not import `vscode` or
  `vscode-languageserver`. Ranges are LSP-shaped plain objects
  (`core/text.ts`), so they can be returned to the client as is.
- **Small files, one concern each.** A new feature is a new file in
  `server/src/features/` plus one line in `server.ts`.
- **All URIs are normalized** with `normalizeUri` (`core/uri.ts`): on
  Windows `file:///C:/x`, `file:///c%3A/x` and `C:\x` are the same key.
  Workspace methods normalize their inputs; symbol `.uri` values are already
  normalized.

## Data flow

```
didOpen/didChange ──► server.ts ──► workspace.updateDocument(uri, text, version)
                                       │  parse(text, uri)  (core/parser.ts)
                                       │  resolve #includes, update include graph
                                       │  update global symbol table
                                       └► onDidChangeModel({ uri, model, affected, fromDisk, namesChanged })
                                              (affected = uri + every includer)
watched file events ──► workspace.fileChanged / fileCreated / fileDeleted
                          new file: load, re-resolve every include, emit for the
                          new file and for every model whose include targets changed;
                          deleted folder: drop every model below it
initialized ──► workspace.indexWorkspace()  (all GLSL files under the roots)
                  then drops models that are neither open nor listed and
                  re-reads files reached through includes (outside the roots too)

request (hover, completion, ...) ──► features/<x>.ts ──► ctx.workspace.* / core helpers ──► LSP result
```

Open-buffer text always wins over disk. Files reached through includes but
outside the roots (or in excluded folders) are loaded lazily by
`workspace.getModel`. A folder containing `.glsl-lsp-ignore`
(`IGNORE_MARKER`) is skipped like an excluded one. `fromDisk` is false only
for edits of open buffers (diagnostics' `onType` gates just those);
`namesChanged` is set when the file's set of top-level names changed.

Indexing the parent shader workspace (about 680 files incl. all of LYGIA)
takes about 0.75 s; parsing is eager. The end-to-end test logs the current
figure (server-reported and wall clock; the ceiling is 15 s, override with
`GLSL_LSP_E2E_INDEX_MS`).

## Core modules (`server/src/core`)

| Module | What it gives you |
| --- | --- |
| `text.ts` | `Position`, `Range`, `LineIndex` (offset <-> position), range helpers |
| `lexer.ts` | `lex(text)` -> `Token[]` incl. comments and whole-line `directive` tokens; `tokenIndexAt` |
| `keywords.ts` | `BASIC_TYPES`, `QUALIFIERS`, `isKeyword`, `RESERVED_WORDS`, `invalidIdentifierReason`, `SWIZZLE_RE`, `isGlslPath` |
| `model.ts` | **The data model** (`FileModel`, symbols, occurrences, calls, scopes, directives, docs) |
| `directives.ts` | `scanDirectives`: #include, #define, conditionals, #version, #iChannel/#iUniform/#iKeyboard |
| `parser.ts` | `parse(text, uri, version?)` -> `FileModel`. Tolerant recursive descent |
| `docs.ts` | doc-comment association, LYGIA YAML parsing, `formatDocMarkdown`, `docSummary`, `paramDoc` |
| `uri.ts` | `normalizeUri`, `resolveUri`, `relativePath`, `fsPathToUri`, ... |
| `fs.ts` | `FileSystem` interface, `NodeFileSystem`, `MemoryFileSystem` (tests) |
| `includes.ts` | `IncludeResolver` (path lookup, `includePathFor`), `IncludeGraph` (closure, includers) |
| `includeEdit.ts` | `computeIncludeInsertion(model, path)` (where: after the last top-level include outside conditionals and before code, else after `#version`/`#extension`/`precision` statements/shader-toy directives, a real include guard, option `#define`s and `#ifndef X`/`#define X v`/`#endif` groups, and a header comment followed by a blank line), `includeInsertionEdit(model, path)` (ready-to-apply: quote style, CRLF, no final newline), `hasIncludePath`, `usesAngleBrackets` |
| `options.ts` | `isOptionMacro(model, macro)`: LYGIA option knobs (`GNOISE_NOISE_FNC`, `FBM_OCTAVES`) |
| `workspace.ts` | `Workspace`: models, indexing, sync, include graph, global table, resolution entry points |
| `resolve.ts` | scopes, `visibleSymbols`, `resolveSymbolAt`, `resolveOccurrence`, types, `callAt`, `findReferences` |
| `signature.ts` | one-line GLSL renderings: `formatFunction`, `formatParam`, `formatSymbol`, builtin overloads |
| `describe.ts` | Markdown for hovers/completion docs: `describeResolution`, `describeSymbols`, `describeBuiltin` |
| `semanticLegend.ts` | semantic token legend + `tokenTypeIndex`, `modifierMask` |
| `index.ts` | barrel: features import everything from `'../core'` |

### The FileModel (`core/model.ts`)

`parse()` returns one `FileModel` per document:

- `tokens` every token (comments and directives included), `lines` a `LineIndex`.
- `symbols` all top-level symbols in source order, also split into
  `functions` (every overload and prototype is its own `FunctionSymbol`),
  `structs`, `globals` (uniforms, consts, in/out, `#iUniform`, block
  instances), `macros`, `blocks` (interface blocks).
- Every symbol has `kind`, `name`, `uri`, `range` (whole declaration),
  `nameRange`, `nameOffset` and optional `doc: DocComment`.
- `rootScope` -> `children` scopes (`function`, `block`, `for`); each scope
  lists its locals/params in `symbols`. `FunctionSymbol.scope` is the
  function scope (starts at `(` so params are inside).
- `occurrences` every identifier, sorted by offset, with a `role`:
  `declaration` (has `.symbol`), `reference`, `call` (has `.call`),
  `member` (after `.`, has `.receiver` = index of the receiver occurrence
  when it was simple), `type` (user type name in a declaration), `directive`
  (identifier inside `#define` bodies / `#if` conditions).
- `calls` every call/constructor `name(...)` with `nameRange`, `openParen`,
  `closeParen` (undefined while unclosed), `args` (ranges), `commas`
  (offsets), `isConstructor` (basic type), `occurrence`.
- `includes` (`path`, `pathRange`, `range`, `resolvedUri` filled by the
  Workspace), `directives`, `conditionals`, `glslVersion`, `shadertoy`
  (`channels`, `keyboard`, `hasMainImage`).
- `fileDoc`, `folding` (raw extents: `code` braces/conditionals, `comment`,
  `imports`, `region`), `brackets`, `issues` (soft parse problems).

Preprocessor conditions are **not evaluated**: all branches are parsed,
except when a group's branches do not balance their braces (e.g. alternative
`for (...) {` headers sharing one body): then only the first branch is parsed.
Groups are measured innermost first, ignoring branches already skipped.

Error recovery while typing: a function body that is never closed ends at the
next `T name(...) {` (macro qualifiers such as `HIGHP` included), at a
declaration only valid at file scope (`uniform`, `in`, `out`, `layout`, ...),
or at `struct`/`const` in column 0. An unclosed struct, interface block or
parameter list ends before a following function definition (structs and blocks
also before a file-scope-only declaration such as `uniform` or a column-0 `const`).
Upper-case macros in qualifier position (`HIGHP float x`) are kept as
qualifiers, and soft reserved words (`sample`, `centroid`, ... see
`SOFT_KEYWORDS`) are accepted as names, as LYGIA uses them.

### Doc comments (`core/docs.ts`)

- *Above*: contiguous `//` lines or a `/* */` / `/** */` block ending on the
  line directly above the declaration. A blank line breaks the association;
  a comment that trails code on its line belongs to that code.
- *Trailing*: `float x; // doc` for variables, fields, params
  (multi-line parameter lists too), `#define` and `#iUniform`.
- *LYGIA*: a block with `description:`/`use:` keys is parsed as YAML-ish
  (`DocComment.style === 'yaml'`, `.yaml.values/.lists`). It becomes
  `fileDoc` and is inherited (`inherited: true`) by every function, struct
  and non-guard macro of the file without its own doc. Macros listed under
  `options:` get their option description.
- `formatDocMarkdown(doc)` renders either style. LYGIA: description,
  **Usage** code block, **Options** list, examples links, contributors in
  italics, license dropped. Plain: paragraphs joined, `-` lists kept,
  indented lines become `glsl` code blocks, `@param`/`@return` tags.

### Include resolution (`core/includes.ts`)

`#include "p"` in file F resolves, first match wins: relative to F's
folder, each `glslLsp.includePaths` entry (absolute or relative to each
root), each workspace root. `workspace.transitiveIncludes(uri)` is the
depth-first closure in include order (cycle-safe, cached, invalidated on any
change). On case-insensitive file systems (`FileSystem.caseInsensitive`) a
candidate is matched against known model keys ignoring case, then spelled with
the on-disk case (`FileSystem.canonical`), so `#include "../my lib/x.glsl"`
and the indexed `My Lib/X.glsl` are one model. `NodeFileSystem.readFile`
strips a UTF-8 BOM. Include guards are not needed for correctness: each file appears
once. `workspace.includePathFor(from, target)` produces the path text to
write (relative to `from`'s folder, like the shader-toy extension).

### Name resolution (`core/resolve.ts`)

For a name used in file F at offset o:

1. locals/params of enclosing scopes declared before o (innermost first);
   a local is visible from `VariableSymbol.visibleFrom` (after its
   initializer), so `float d = d * 2.0;` reads the outer `d`,
2. top-level symbols of F,
3. top-level symbols of F's transitive includes,
4. builtins (respecting `glslLsp.shadertoy.enable`),
5. fallback: any indexed file declaring the name, preferring files visible
   from F's includers (`fromWorkspace: true`). This keeps library files that
   rely on their includer's includes navigable, and lets hovers say
   "not included here".

Members resolve through the receiver type: the static type of the expression
before the `.` (`typeOfExpressionEndingAt`: identifiers, members, calls,
constructors, `[i]` subscripts via `indexedType`), giving struct and block
fields, or swizzles (`kind: 'swizzle'` with `resultType`). Builtin calls with
generic return types (`genType`, `gvec4`, `bvec`, `mat`) get a concrete type
from their arguments (`concreteBuiltinReturn`, `typeOfArgument`). Functions
return every overload in `symbols` and the best match by argument count in
`primary`.

`findReferences` matches by `symbolKey` (locals/params and local structs by
offset, functions per file). Fields of instance-less blocks also match bare
uses. For functions, the key set grows with every overload a matching call
site sees, so overloads split across a library and its includer are found
(and renamed) together.

```ts
type Resolution =
  | { kind: 'symbol'; name; symbols: GlslSymbol[]; primary: GlslSymbol; occurrence?; call?; fromWorkspace? }
  | { kind: 'builtin'; name; entry: BuiltinEntry; occurrence?; call? }
  | { kind: 'include'; include: IncludeDirective; targetUri? }
  | { kind: 'swizzle'; name; occurrence; receiverType?; resultType? };
```

## Workspace API (`core/workspace.ts`)

| Method | Use |
| --- | --- |
| `getModel(uri)` | FileModel (open buffer, indexed, or lazily read from disk) |
| `peekModel(uri)`, `allModels()`, `size` | inspection without loading |
| `openDocument/updateDocument/closeDocument` | buffer sync (server.ts does this) |
| `fileChanged/fileCreated/fileDeleted` | watched-file sync (server.ts does this) |
| `onDidChangeModel(listener)` | `{ uri, model?, affected }` after each reparse/removal |
| `resolveInclude(from, path)`, `includePathFor(from, target)` | include paths |
| `transitiveIncludes(uri)`, `isReachable(from, target)` | include closure (`isReachable` uses a cached Set) |
| `directIncluders(uri)`, `transitiveIncluders(uri)` | reverse graph |
| `lookupGlobal(name)` | every top-level symbol with that name in any indexed file |
| `findDeclaringFiles(name)` | candidate files for auto-include (guards excluded) |
| `allGlobalSymbols()`, `globalNames()` | workspace symbols / completion of not-yet-included names |
| `visibleSymbols(uri, pos)` | `{ locals, globals, blockFields, files }` |
| `resolveSymbolAt(uri, pos)`, `resolveOccurrence(model, i)` | see above |
| `findReferences(uri, pos, includeDeclaration)` | `{ uri, range, isDeclaration }[]` across files |
| `builtinFilter(model?)` | filter for `builtins.allFunctions(filter)` etc. |
| `displayPath(uri)` | workspace-relative path for UI text |

Free functions in `resolve.ts`: `scopeAt`, `localsAt`, `enclosingFunction`,
`occurrenceIndexAt`, `callAt(model, offset)` (innermost call, unclosed calls
included), `activeArgument(call, offset)`, `lookupName`, `pickOverload`,
`swizzleType`, `findStructType`, `symbolType`, `typeOfOccurrence`,
`symbolKey`, `isLocalSymbol`.

## ServerContext (`server/src/context.ts`)

```ts
interface ServerContext {
  connection: Connection;               // register handlers here
  documents: TextDocuments<TextDocument>;
  workspace: Workspace;
  builtins: Builtins;                   // server/src/builtins
  settings: SettingsStore;              // .get(), .onDidChange()
  log: Logger;                          // error/warn/info/debug
  getModel(uri): FileModel | undefined;
  getDocument(uri): TextDocument | undefined;
  onModelChanged(listener): Disposable; // = workspace.onDidChangeModel
  onIndexed(listener): Disposable;      // initial index finished
  readonly indexed: boolean;
  clientCapabilities: { snippetSupport; markdown; workDoneProgress; semanticTokensRefresh; inlayHintRefresh };
}
```

Request params carry the client's URI spelling; pass it to `ctx.workspace`
methods as is (they normalize) or call `normalizeUri` first when comparing
with `symbol.uri`.

## Settings (`server/src/settings.ts`)

`Settings` + `defaultSettings` mirror `contributes.configuration` in
`package.json` one to one; `test/settings.test.ts` fails when they drift.
`SettingsStore.update(raw)` deep-merges the client's `glslLsp` section over
the defaults, dropping values of the wrong type and normalizing enums
(a legacy boolean `inlayHints.parameterNames` maps to `literals`/`none`).
server.ts pulls settings with `workspace/configuration` on start and on every
`didChangeConfiguration`; features read `ctx.settings.get()` per request
and use `ctx.settings.onDidChange((s, prev) => ...)` to react (diagnostics
re-validates, inlay hints ask the client to refresh, the workspace
re-resolves includes when `includePaths` change).

## How to add a feature

1. Create `server/src/features/<name>.ts` exporting
   `register(ctx: ServerContext): void`. Keep the computation in an exported
   pure function (`computeX(ws, model, ...)`) so tests can call it with a
   `Workspace` built by `test/helpers.ts#makeWorkspace`. If the feature grows
   past ~300 lines, split helpers into `server/src/features/<name>/*.ts`
   (see `completion/` and `diagnostics/`).
2. Import it in `server/src/server.ts`, add it to `FEATURES`, and advertise
   its capability in `onInitialize` (if it is a new LSP capability).
3. If it needs a setting: add it to `package.json`
   (`contributes.configuration`, namespace `glslLsp`) **and** to `Settings`
   + `defaultSettings` in `server/src/settings.ts` (the settings test
   enforces this). Enums: add a case to `normalize()`.
4. Need something from the GLSL model that is missing? Add it to core (with
   a test) rather than re-parsing text in the feature. Logic two features
   share belongs in core too (e.g. `includeInsertionEdit`, `isOptionMacro`).
5. Wrap handler bodies in try/catch and log with `ctx.log.error`.
6. Add `test/<name>.test.ts`. Run `npm run typecheck && npm test && npm run build`.
   If the feature is user-visible, add an assertion to
   `test/e2e/server.e2e.test.ts`.
7. Mention it in README.md and CHANGELOG.md.

## Feature map

Every feature exports `register(ctx)` plus pure `compute*` functions that the
tests call directly.

| File | Capabilities | Entry points |
| --- | --- | --- |
| `hover.ts` | hover | `computeHover` -> `core/describe.ts` |
| `completion.ts` + `completion/*` | completion, completionItem/resolve | `computeCompletion`, `resolveCompletionItem` |
| `autoInclude.ts` | (shared by completion + code actions) | `IncludeContext`, `includeTextEdit` |
| `codeActions.ts` | quick fixes / source actions | `computeCodeActions` |
| `navigation.ts` | definition, declaration, typeDefinition, references, rename + prepareRename, documentHighlight, documentSymbol, workspaceSymbol, documentLink | `computeDefinition`, ..., `computeDocumentLinks` |
| `diagnostics.ts` + `diagnostics/*` | push diagnostics | `computeFastDiagnostics`, `computeGlslangDiagnostics`, `flatten` |
| `signatureHelp.ts` | signatureHelp | `computeSignatureHelp`, `resolveCallCandidates`, `pickActiveCandidate` |
| `inlayHints.ts` | inlayHint | `computeInlayHints` (reuses signatureHelp's call matching) |
| `semanticTokens.ts` | semanticTokens full + range | `computeSemanticTokens` |
| `refresh.ts` | semanticTokens / inlayHint refresh requests | `onDependentsChanged` |
| `folding.ts` | foldingRange, selectionRange | `computeFoldingRanges`, `computeSelectionRanges` |
| `colors.ts` | documentColor, colorPresentation | `computeDocumentColors`, `computeColorPresentations` |

### hover

`ctx.workspace.resolveSymbolAt(uri, pos)` -> `describeResolution(ws, res, uri)`
(`core/describe.ts`). To change hover text, edit `core/describe.ts`;
completion documentation and signature help reuse it.

### completion (`completion.ts`, `completion/`)

- `context.ts` `analyzeContext(model, offset)` classifies the cursor:
  `none` (comment, number, division), `directiveName`, `includePath`,
  `macroName`, `version`, `extension`, `member`, `identifier`. Add a new
  context kind there, then a case in `computeCompletion`.
- `identifiers.ts`: locals -> file -> includes -> builtins -> keywords, then
  `workspaceCompletions` (not-yet-included symbols, max 300; with an empty
  prefix only functions and structs, ranked `lib/` first, then core LYGIA
  folders, then shorter paths). Nothing at a declarator position
  (`float gno|`). `types.ts#sortText` encodes that ranking.
- `members.ts`: receiver type via `typeOfOccurrence`, plus its own
  expression-chain inference; swizzles and fields.
- `preprocessor.ts`, `includePaths.ts`: `#` directives and include paths.
- `items.ts`: kinds, details, `name($0)` call snippets.
- `resolveItem.ts`: documentation is filled lazily on resolve from
  `item.data` (`describeSymbols` / `describeBuiltin`).

Trigger characters (server.ts `COMPLETION_TRIGGERS`): `.`, `#`, `"`, `<`, `/`.
Each context ignores triggers that do not belong to it (`/` as division,
`<` as less-than).

### auto-include (`autoInclude.ts`)

`new IncludeContext(ws, model)` precomputes the closure and includers of the
file. `candidatesFor(name)` lists `{ targetUri, path, declaringUri, via }`.
It skips files already visible, the file itself, includers (cycles), entry
points (`mainImage`/`main`) and option macros (`core/options.ts`). A user
library in another top-level folder that already includes the declaring file
is preferred (`via: true`), unless it is a shader's own multipass common file
(every includer is an entry point in its folder), and test/fixture folders
sort last.
`includeEdit(path)` returns the `TextEdit` built from core
`includeInsertionEdit`.

### code actions (`codeActions.ts`)

- *Add `#include`*: for diagnostics with code `undeclared-identifier`
  (`UNDECLARED_IDENTIFIER`, `data: { name }`) or the unresolved identifier
  under the cursor.
- *Change to `"..."`*: for an unresolved include path, files with the same
  base name.
- *Remove unused / redundant include*: unused is decided by name, and
  re-exports used by the file's includers count as uses. Redundant means
  provided by an earlier include, or by a later one when nothing uses those
  names before it.

### navigation (`navigation.ts`)

Everything goes through `resolveSymbolAt` / `findReferences`. Definition
prefers non-prototypes and the overload matching the argument count, then the
argument types (signature help's `inferArgType`/`typeScore`); declaration adds
prototypes back. Rename validates the new name (`invalidIdentifierReason`:
identifier, not a keyword, reserved word, `gl_` prefix or `__`; not a builtin)
and refuses builtins, swizzles, include paths and symbols declared in a
read-only folder (`glslLsp.rename.readOnlyPaths`, default `["lygia"]`, plus
files outside the workspace folders that are not open). Refusals are thrown
as `ResponseError`s so the client shows the reason. Document links cover
`#include` paths and `#iChannelN "file://..."` / relative paths (a cubemap
`{}` pattern links its first existing face).

### diagnostics (`diagnostics.ts`, `diagnostics/`)

- `fast.ts`: unresolved includes, include cycles, parser `model.issues`,
  duplicate definitions (outside conditionals), undeclared identifiers.
  Undeclared names are skipped in uncertain places: non-guard `#if`
  regions, names that macros might generate, and files with `##`.
  `knownNames.ts` lists the few accepted names that are not real builtins.
- `flatten.ts`: `planValidation` decides whether and how a file is
  validated (stage from `x.vert`, `x.vert.glsl`, `x.vs.glsl`, ...).
  Shadertoy files (`mainImage`) get the shader-toy extension's
  WebGL2 preamble (mirrors the parent workspace's `tools/flatten.py`):
  uniforms, `iChannelN` sampler types from `#iChannelN::Type`, `#iKeyboard`
  stubs and `#iUniform` uniforms, plus a generated `main()`. Files with
  `main` and `#version` pass through. Libraries are skipped. `flatten`
  inlines includes and returns a line map back to `(uri, line)`. Each inlined
  file is wrapped in a synthetic guard (`#ifndef GLSLLSP_INCLUDED_<n>`) so the
  preprocessor dedupes; a file already inlined outside any conditional is not
  inlined again. User `#line` directives are blanked. `unclosedConditionals`
  lists the lines of user `#if`s without `#endif`, so a real 'missing #endif'
  (which glslang reports at the end of the unit) lands on them.
- `glslang.ts`: `runGlslang` pipes the source into
  `glslangValidator --stdin -S <stage>` (5 s timeout, abortable; `.cmd`/`.bat`
  wrappers run through a shell; a process that cannot start is `missing`).
  A non-zero exit without parsed messages is a failure, not a clean compile.
  `parseGlslangOutput` drops 'missing #endif' when compilation terminated
  early (glslang then reports every still-open `#if`, synthetic guards
  included). `mapGlslangMessages` maps errors back through the line map. Errors in an
  included file are reported on that file, plus a summary on the root's
  `#include`.
- `store.ts`: merges the fast layer with one glslang layer per root file and
  removes duplicates (the same undeclared name or undefined call, or a syntax
  issue on a line glslang also reports). A collapsed undeclared-name pair keeps
  the fast diagnostic (its code/data drive "Add #include") with glslang's
  severity.
- `register`: validates immediately on open and save, and debounced (300 ms)
  on change when `diagnostics.onType` is on (edits of open buffers only: disk
  changes always re-validate). Includers are re-validated when an included
  file changes. When a file's declared names change, open files with
  undeclared-identifier diagnostics get their fast checks re-run (the
  "declared in X" hint depends on the whole workspace).

### signature help and inlay hints

`resolveCallCandidates(ws, model, call)` returns every overload as a
candidate. Sources are user functions, function-like macros, struct
constructors, builtins, and generated `vecN`/`matN` constructors.
`pickActiveCandidate` ranks the candidates by arity, then by argument types
from `inferArgType`, which handles literals, identifiers, swizzles and calls.
`computeInlayHints` reuses both and hints `name:` on arguments.
`inlayHints.parameterNames` controls which arguments get a hint: `none`,
`literals` or `all`.

### semantic tokens (`semanticTokens.ts`)

Classifies `model.occurrences` through `resolveOccurrence` and encodes them
with `tokenTypeIndex`/`modifierMask` from `core/semanticLegend.ts`. Append
new legend entries at the end only. `refresh.ts#onDependentsChanged` asks the
client to refresh semantic tokens and inlay hints (debounced, only with
`refreshSupport`) when an included file of an open document changes, names
change, or indexing finishes.

### folding and selection (`folding.ts`)

Folding ranges come from `model.folding`. The closing line stays visible,
and each `#if/#else/#endif` branch is its own fold. Selection ranges build
a nested chain: word, argument, call, bracket contents, bracket pair,
statement, block, scope, function, file.

### colors (`colors.ts`)

Covers `vec3`/`vec4` constructors whose arguments are all float literals in
[0, 1], `#define X vec3(...)` bodies and `#iUniform color3` defaults.
`colors.mode: heuristic` only keeps literals that look like colors. That
means one of these names reads as a color (`col`, `color`, `tint`, ...):
the assigned variable, the callee's parameter, the function returning it,
or the `#define`. Weak words (`light`, `sun`, `diffuse`...) are vetoed by
geometry words (`dir`, `pos`, `normal`...), geometric callees (`normalize`,
`dot`...) and scalar targets. `formatColorPresentation` keeps the user's constructor and
number style.

## Builtins (`server/src/builtins`)

`types.ts` defines `BuiltinFunction` (overloads with named params, doc,
`minVersion`, `stages`, `docUrl`, `shadertoy`, `requiresDirective`,
`snippet`), `BuiltinVariable`, `BuiltinType`, `BuiltinKeyword`,
`BuiltinDirective`, `BuiltinMacro`. Functions are written compactly with
`define.ts`. For example,
`fn('mix', 'common', doc, ['genType mix(genType x, genType y, genType a)', ...])`
parses GLSL-style signatures, and `@400 ...` marks a minimum version. Data
files:

- `functionsMath.ts`, `functionsMath2.ts`, `functionsTexture.ts` (texture
  overloads generated from sampler families), `functionsMisc.ts`;
- `variables.ts`, `typesData.ts`, `keywords.ts`, `layout.ts`,
  `directives.ts`, `macros.ts`;
- `shadertoy.ts`: Shadertoy uniforms, `#iKeyboard` helpers and `Key_*`, and
  the wallpaper-engine inputs.

`index.ts` aggregates everything into the `Builtins` registry:
`get(name, filter)` and `allFunctions` / `allVariables` / `allTypes` /
`allDirectives(filter)`. The filter covers the shadertoy setting, required
directives and the GLSL version. To add a builtin, add an entry to the
matching data file; `test/builtins.test.ts` checks that every entry has a
doc, a category and unique overloads.

## Testing

- `npm test` runs everything with vitest. `npm run test:e2e` runs only the
  end-to-end test.
- `test/helpers.ts`: `makeWorkspace({ 'path.glsl': text })` (in-memory,
  rooted at `file:///ws`), `posOf(text, needle, delta)`, `cursor('a|b')`.
  `test/completionHelpers.ts` holds a richer shared fixture project.
- `test/fixtures/project`, `test/fixtures/diagnostics`: on-disk projects for
  `NodeFileSystem` tests.
- Real-workspace tests are skipped when `../lygia` is absent:
  - `test/lygia.smoke.test.ts` parses every LYGIA file;
  - `test/diagnostics.realworld.test.ts` runs the fast checks and
    glslangValidator over the user's shaders and expects no errors;
  - `test/autoInclude.test.ts` times completion.
- `test/e2e/server.e2e.test.ts` builds `dist/server.js` and spawns it over
  stdio with `vscode-jsonrpc`. It initializes on the parent shader workspace
  (or `GLSL_LSP_E2E_ROOT`) and checks the following:
  - index time is under 5 s;
  - hover shows `//` docs and LYGIA YAML docs;
  - completion with an auto-include edit;
  - definition, signature help, document symbols and semantic tokens;
  - every shader in the workspace has zero error diagnostics;
  - a deliberate type error is reported by glslang.

  Set `GLSL_LSP_E2E_NO_BUILD=1` to test the minified bundle produced by
  `npm run package`.
- Feature tests call the exported pure functions (e.g. `computeHover`).

## Packaging

`npm run package` runs `vscode:prepublish`, a minified esbuild build without
source maps, and then `vsce package --no-dependencies`. `vscode-languageclient`
and `vscode-languageserver` are bundled into `dist/*.js`, so no
`node_modules` ship. `.vscodeignore` whitelists `dist/client.js`,
`dist/server.js`, `syntaxes/`, `language-configuration.json`, README,
CHANGELOG and LICENSE.
