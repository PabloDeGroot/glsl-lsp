# Changelog

## 0.3.0

glsl-lsp is now a standalone, generic GLSL extension: Shadertoy support is
optional, and runtime-specific uniforms are configured instead of built in.

- **Environment settings**:
  - `glslLsp.environment.uniforms`: `{ name, type, doc? }` entries (arrays as
    `vec4[16]`) for uniforms your shader runtime provides. They behave like
    builtins: hover (signature, Markdown doc, *Environment uniform*),
    completion, semantic tokens (`defaultLibrary`, `readonly`), member and
    index typing (`trail[0].xy`), no undeclared-identifier report, and
    declarations in the `glslangValidator` preamble (skipped when the shader
    declares the name itself).
  - `glslLsp.environment.defines`: `{ "NAME": "value" }` macros, known to
    hover (*Environment define*), completion and the undeclared check, and
    passed to `glslangValidator` as `#define`s.
  - Changing either refreshes diagnostics and semantic highlighting without a
    restart.
- **Shadertoy support is optional**: `glslLsp.shadertoy.enable` is now
  `auto` (default) | `on` | `off`; the legacy `true` / `false` mean `on` /
  `off`.
  - `auto` applies Shadertoy builtins, the shader-toy directives and the
    `mainImage` wrapper to files that define `mainImage` or use `#iChannelN`,
    `#iUniform` or `#iKeyboard` (and to the files they include or that
    include them), or to every file when the shader-toy extension is
    installed.
  - `off` is plain GLSL: `mainImage` files are validated as ordinary GLSL
    and Shadertoy names are reported as undeclared.
- **GLSL: Show Shadertoy Preview** (command palette and editor title button)
  runs the shader-toy extension's preview. It only shows when that extension
  is installed; glsl-lsp does not depend on it.
- Removed the extra uniforms of a specific custom runtime from the builtins
  (`iMouseButton`, a shader-toy extension uniform, stays). Declare such
  uniforms with `glslLsp.environment.uniforms`.
- Signature help and member completion type indexed builtin arrays
  (`iChannelResolution[0].xy`).
- Environment entries that would break the `glslangValidator` preamble are
  dropped: names that are keywords or reserved words, types that are not GLSL
  types, and a trailing `\` in a define value (a line continuation).
- `auto` mode: a plain entry shader (it defines `main()`) gets `iTime` and
  other Shadertoy names reported as undeclared; libraries still may use them.
- Legacy boolean `glslLsp.shadertoy.enable` values are rewritten to `on` /
  `off` on startup.
- Errors on generated lines of plain GLSL no longer mention a Shadertoy
  wrapper.
- Marketplace icon and more keywords.
- Tests that use a real shader workspace read it from `GLSL_LSP_E2E_ROOT` (an
  error when that folder does not exist), or use this repository's parent
  folder; either only when it looks like one (a `lygia/` folder or `.glsl`
  files), and skip otherwise. The end-to-end test runs on scratch buffers, so
  any such workspace works. **Run Extension** opens `test/fixtures/project`.

## 0.2.0

- **Values panel** (new Activity Bar view **GLSL › Values**): interactive
  widgets for the numbers in a shader, inspired by glslEditor.
  - A list with the value at the cursor always on top (with a pin button) and
    your pinned values below it, each with a live preview (swatch, numbers,
    arrow). Pins are stored per workspace, re-found by declaration name or line
    shape after edits, keep working for other files, and show *not found* when
    their value is deleted.
  - A widget area for the selected row: slider for floats (`#iUniform` ranges
    or an editable automatic range), 2D trackpad for `vec2`, color picker
    (SV square, hue, alpha, hex/RGB, HDR intensity) or trackball direction
    picker for `vec3`/`vec4` with a Color | Vector toggle, one slider per
    number for lines with several literals, and a cosine palette editor with
    gradient, curves and presets.
  - Dragging rewrites the literal live (throttled, `glslLsp.values.throttleMs`),
    one undo step per drag; typing in the same spot stops the drag instead of
    fighting you. Numbers in the list can be scrubbed by dragging sideways.
  - Commands **GLSL: Pin Value at Cursor** (also in the editor context menu),
    **GLSL: Unpin All Values**, **GLSL: Focus Values Panel**.
  - Native look from the VS Code theme (light, dark, high contrast), crisp
    canvases, full keyboard support, strict content security policy.
- **Nudge commands**: `Ctrl+Alt+Up/Down` (`Ctrl+Shift+Alt+Up/Down` for x10)
  in GLSL editors increment/decrement the number under the cursor by its last
  decimal place, with multiple cursors. When the cursor is not on a number
  the keys do what they do by default on the platform (*Add Cursor
  Above/Below* on Windows, column selection), so multi-cursor editing keeps
  working in GLSL files; several cursors nudge only when all are on numbers.
- New settings `glslLsp.values.throttleMs`, `glslLsp.values.maxDecimals`,
  `glslLsp.values.followCursor`.
- Server: custom request `glslLsp/valueTargets` (no capability needed; answers
  `null` / `match: 'none'` for unknown documents instead of failing).

- **Completion**
  - Ctrl+Space with an empty prefix now lists not-yet-included functions and
    structs (up to 300: `lib/` first, then core LYGIA folders, shorter paths
    first), each adding its `#include` when accepted.
  - No completion (and no auto-include) where a new variable, parameter or
    field is being named (`float gno|`).
  - Swizzles after builtin calls with generic return types
    (`texture(...).rgb`, `normalize(v).xy`), indexed matrices/vectors
    (`m[0].x`) and constructors (`vec3(1.0).y`).
  - `#include` path completion in the middle of a path replaces the rest of
    the segment (folders) or the path (files).
  - A shader's multipass `common.glsl` is no longer offered as a library
    re-exporting what it includes.
- **Include insertion**: never inside an `#if` block or below code; after
  option `#define`s and `#ifndef X`/`#define X v`/`#endif` defaults (not inside
  them); a doc comment directly above the first declaration stays attached.
- **Code actions**: *Remove redundant `#include`* takes include order into
  account.
- **References / rename**
  - Bare uses of fields of instance-less interface blocks are found.
  - `r.time` in a `#define` body is a member access, not the global `time`.
  - A local's scope starts after its initializer (`float d = d * 2.0;`).
  - Local structs of the same name in different functions are separate.
  - Overloads split across a library and its includer are renamed together.
  - Rename refuses reserved words, `gl_` names and `__`, builtins, and symbols
    declared in read-only folders (new setting `glslLsp.rename.readOnlyPaths`,
    default `["lygia"]`), with a message saying why.
- **Navigation**: go to definition picks the overload by argument types;
  signature help is not confused by `;`/braces in comments and picks the 2D
  `texture` overload for `sampler2D` arguments; cubemap `#iChannel` links point
  to an existing face.
- **Parser**: an unterminated function body no longer swallows the uniforms,
  structs and consts after it; an unclosed struct, interface block or
  parameter list no longer swallows the next function; nested brace-sharing
  `#if` groups no longer drop a balanced outer `#else`; a trailing comment
  only documents the declaration it follows; LYGIA options written with
  parameters (`X_SAMPLER_FNC(TEX, UV): ...`) match their macro.
- **Workspace**
  - `#include` spellings that differ in case from the file on disk (Windows,
    macOS) resolve to the same file.
  - Creating, deleting or renaming files and folders re-resolves includes and
    re-validates the files that include them.
  - Re-indexing (also after changing `glslLsp.index.exclude` or removing a
    workspace folder) drops files that are no longer indexed and reloads
    included files outside the workspace.
  - Watched-file events inside excluded folders do not index those files.
  - A folder containing a `.glsl-lsp-ignore` file is never indexed (this
    repository's `test/fixtures/` has one).
  - A UTF-8 byte order mark at the start of a file is ignored.
  - `.fs`/`.vs` are no longer claimed as GLSL (F# and others use them).
- **Diagnostics**
  - Files included inside an inactive `#if` branch no longer hide their later
    unconditional include from `glslangValidator`.
  - `#line` directives no longer shift reported lines.
  - `*.vert.glsl` / `*.vs.glsl` etc. are validated with the right stage.
  - `glslangValidator` given as a `.cmd`/`.bat` wrapper works; one that cannot
    start or exits with an error and no output shows a warning instead of
    silently reporting a clean compile.
  - An undefined function call is reported once (glslang's duplicate is
    dropped).
  - `diagnostics.onType = false` only defers re-validation of edits, not of
    changes on disk; the "declared in X" hint follows declarations added or
    removed in other files.
- **Semantic tokens and inlay hints** are refreshed when an included file
  changes or indexing finishes; a client without refresh support no longer
  causes an error in the log.
- **Colors**: no swatches on direction/position vectors (`lightDir`, `sunPos`,
  `dot(n, vec3(...))`).

## 0.1.0

First release.

- **Core**
  - Tolerant lexer and parser that never throws on code being edited.
  - Directive scanner covering `#include`, `#define`, conditionals and the
    shader-toy directives.
  - Doc-comment extraction: `//` and `/* */` comments above a declaration,
    trailing comments, and LYGIA YAML blocks.
  - Include resolution, include graph and workspace index. Indexing the full
    LYGIA tree takes about 0.65 s.
- **Hover**: every overload's signature, rendered docs, where the symbol is
  defined, and the `#include` to add when it is not included yet.
- **Completion**
  - Context aware: locals, file, includes, builtins and keywords; swizzles
    and fields after `.`; directives after `#`; paths inside `#include "`.
  - **Auto-include**: accepting a symbol from a file that is not included yet
    adds its relative `#include` line.
- **Code actions**: add a missing `#include`, fix an include path, remove an
  unused or redundant `#include`.
- **Navigation**
  - Go to definition, declaration and type definition.
  - References, document highlight and rename (scope aware).
  - Document symbols and workspace symbols.
  - Links on `#include` and `#iChannel` paths.
- **Diagnostics**
  - Fast in-process checks: unresolved and cyclic includes, syntax,
    duplicate definitions, undeclared identifiers.
  - `glslangValidator` with the shader-toy WebGL2 preamble. Includes are
    flattened and errors are mapped back to the file they occur in.
- **Signature help** with overload selection by argument types, and
  **parameter-name inlay hints**.
- **Presentation**: semantic tokens, folding and selection ranges, and a
  color picker for `vec3`/`vec4` literals.
- **Builtins**
  - GLSL 4.60 / ES 3.x functions, variables, types, qualifiers and
    directives, with docs and Khronos links.
  - Shadertoy uniforms, `#iKeyboard` helpers and `Key_*` constants, plus a
    few extra uniforms of a custom runtime (removed in 0.3.0 in favour of
    `glslLsp.environment.uniforms`).
- **Settings**:
  - `diagnostics.enable`, `diagnostics.undeclared`;
  - `inlayHints.parameterNames` (`none` / `literals` / `all`);
  - `colors.mode`;
  - `index.exclude`, which accepts relative paths.
- TextMate grammar, language configuration, and an end-to-end test that drives
  the bundled server over stdio.
