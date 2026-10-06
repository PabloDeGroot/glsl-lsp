# GLSL Language Server

A modern language server and VS Code extension for GLSL. It is built for
Shadertoy-style shaders and for large include-based libraries such as
[LYGIA](https://lygia.xyz), but it works on plain `.vert` / `.frag` / `.comp`
files too.

It ships as one extension: a small client (`dist/client.js`) that starts the
bundled language server (`dist/server.js`). There is no runtime dependency
except an optional `glslangValidator` on `PATH`.

## Features

### Hover with your doc comments

Hovering a function, struct, macro, uniform, variable or `#include` path
shows every overload's signature, its documentation rendered as Markdown,
and where it is defined. Two doc styles are understood:

```glsl
// Centered and aspect corrected: y spans [-1, 1], x spans [-aspect, aspect].
// This is the coordinate space you want for almost everything.
vec2 uvCentered(vec2 fragCoord, vec2 res) { ... }
```

```glsl
/*
contributors: Patricio Gonzalez Vivo
description: Gradient Noise
use: gnoise(<float> x)
options:
  - GNOISE_NOISE_FNC: ...
*/
#ifndef FNC_GNOISE
#define FNC_GNOISE
float gnoise(float x) { ... }
```

- **`//` and `/* */` comments** directly above a declaration (a blank line
  breaks the link). A trailing `// comment` documents variables, fields,
  parameters, `#define`s and `#iUniform`s.
- **LYGIA YAML blocks** apply to every function in the file. They are shown as
  the description, a *Usage* code block, *Options* and *Examples*. An option
  macro such as `GNOISE_NOISE_FNC` shows its own line from `options:`.
- **Builtins** (about 180 GLSL function families with every overload, `gl_*`
  variables, types, qualifiers and the Shadertoy uniforms) have docs and a
  link to the Khronos reference page.
- If a symbol exists in the workspace but is **not included** in the current
  file, the hover says which `#include` would bring it in.

### Completion with automatic `#include`

Start typing a function name (or press Ctrl+Space) and pick it from the list.
If it lives in a file that the current shader does not include yet (directly
or through other includes), the matching line is added for you:

```glsl
#include "lib/sdf.glsl"
#include "lygia/generative/voronoi.glsl"   // <- inserted when you accept `voronoi`

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec3 v = voronoi(uv * 4.0, iTime);
```

- The path is written relative to the current file. It uses `<...>` when
  every existing include does, and it keeps CRLF line endings.
- The new line goes after the last top-level `#include` (not one inside an
  `#if` block or below code). With no includes yet, it goes after `#version` /
  `#extension` / `#iChannel` lines, an include guard, option `#define`s
  (LYGIA options must come before the library's include) and `#ifndef X` /
  `#define X 4` / `#endif` defaults, and a header comment that is followed by a
  blank line. A comment directly above the first declaration is its doc
  comment and stays attached to it.
- With an empty prefix (Ctrl+Space) up to 300 not-yet-included functions and
  structs are listed, `lib/` first, then LYGIA's generative, math, color, sdf,
  draw and space folders, then shorter paths. Typing narrows the full set.
- If one of your own library files already includes the defining LYGIA file
  (for example `lib/procedural.glsl` for `gnoise`), that library is offered
  first. Another shader's multipass `common.glsl` (only included by the shaders
  next to it) is never offered as such a library.
- Nothing is offered where you are naming a new variable, parameter or field
  (`float gno|`).
- Nothing is offered when the symbol is already reachable, for shader entry
  points (files with `mainImage`/`main`), for files that include the current
  one (that would be a cycle), or for LYGIA option macros.

The rest of completion is context aware:

- **Identifiers:** locals in scope, then this file, then included files, then
  builtins, then keywords.
- **Members after `.`:** swizzles limited to the vector size (`xyzw`, `rgba`,
  `stpq`), struct fields, and `length()` on arrays.
- **Preprocessor:** directive snippets after `#`, file and folder paths
  inside `#include "`, macro names after `#ifdef`, `#version` profiles and
  `#extension` names.
- **Functions** insert `name($0)` and open signature help.

### Everything else

| Feature | What it does |
| --- | --- |
| **Signature help** | Every overload, with the active parameter, per-parameter docs, struct and `vecN`/`matN` constructors, and function-like macros. The best overload is picked by argument count and types. |
| **Inlay hints** | Parameter names on literal arguments, e.g. `smoothstep(edge0: 0.2, edge1: 0.8, d)`. |
| **Go to definition / declaration / type definition** | Into `lib/` and LYGIA. The overload is picked by argument count and types. Ctrl+click on an `#include` path opens the file. |
| **References, document highlight, rename** | Scope-aware (locals never leak, `float d = d * 2.0;` reads the outer `d`) and across included files, including overloads split between a library and its includer. Rename refuses builtins, keywords, reserved words (`class`, `input`, `gl_*`, `a__b`) and symbols declared in read-only folders (`glslLsp.rename.readOnlyPaths`, LYGIA by default), and says why. |
| **Document / workspace symbols** | Outline with struct fields; fuzzy workspace search (Ctrl+T) over every function, struct and macro. |
| **Diagnostics** | See the next section. |
| **Code actions** | *Add `#include "..."`* for an undeclared name. *Change to `"..."`* for an include that can't be found. *Remove unused / redundant `#include`*. |
| **Semantic highlighting** | Functions, parameters, globals, uniforms (readonly), struct fields, macros and builtins (`defaultLibrary`). |
| **Folding and smart selection** | Braces, `#if`/`#else` branches, comment blocks, include runs and `// region` markers. Expand-selection steps out from word to argument, call, statement, block and function. |
| **Color picker** | On `vec3(1.0, 0.5, 0.2)` style literals that are clearly colors, `#define` color constants and `#iUniform color3` defaults. |
| **Syntax highlighting** | TextMate grammar with shader-toy directives, LYGIA doc keys and macro constants. Enter continues `//` and `/** */` comments. |

### Diagnostics

Diagnostics come in two layers:

1. **Fast checks** run in process on every edit:
   - unresolved `#include`s and include cycles;
   - syntax errors;
   - duplicate definitions;
   - undeclared identifiers. A name declared in a workspace file you don't
     include is an error with an *Add #include* quick fix. Other unknown names
     are warnings.
2. **`glslangValidator`** runs when a shader is opened or saved, and while you
   type (debounced) when `diagnostics.onType` is on.
   - Shadertoy-style files are wrapped in the shader-toy extension's WebGL2
     preamble (uniforms, `iChannel0-3` with their `#iChannel` types,
     `#iKeyboard` helpers, `#iUniform`s) and a generated `main()`.
   - Includes are inlined. Errors inside an included file are reported on that
     file, plus a summary on the `#include` line.
   - Library files without `main`/`mainImage` are checked through the shaders
     that include them.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `glslLsp.includePaths` | `[]` | Extra include directories, searched after the including file's folder (absolute, or relative to each workspace folder). |
| `glslLsp.diagnostics.enable` | `true` | Master switch for all diagnostics. |
| `glslLsp.diagnostics.undeclared` | `true` | Report undeclared identifiers. |
| `glslLsp.diagnostics.glslang.enable` | `true` | Validate with `glslangValidator`. |
| `glslLsp.diagnostics.glslang.path` | `glslangValidator` | Path to the validator executable (a `.cmd`/`.bat` wrapper works on Windows). If it cannot be started or exits with an error and no output, a warning is shown once. |
| `glslLsp.diagnostics.onType` | `true` | Re-validate while typing (debounced) instead of only on open/save. Changes on disk (an included file created, changed or deleted) always re-validate the open files that depend on them. |
| `glslLsp.completion.autoInclude` | `true` | Offer symbols from files that are not included yet, and insert their `#include`. |
| `glslLsp.rename.readOnlyPaths` | `["lygia"]` | Folders a rename never edits. Renaming a symbol declared there is refused. A bare name matches anywhere; an entry containing `/` matches a path relative to the workspace folder. Files outside the workspace folders are read-only unless open. |
| `glslLsp.inlayHints.parameterNames` | `literals` | `none`, `literals` (hint literal arguments only) or `all`. |
| `glslLsp.colors.mode` | `heuristic` | `heuristic` (literals that look like colors), `all` (every `vec3`/`vec4` literal in [0, 1]) or `off`. |
| `glslLsp.shadertoy.enable` | `true` | Shadertoy uniforms, `mainImage` and the shader-toy directives. |
| `glslLsp.index.exclude` | `["node_modules", ".git", "out", "dist", ".vscode-test"]` | Folders skipped when indexing. A bare name matches anywhere; an entry containing `/` (e.g. `glsl-lsp/test/fixtures`) matches a path relative to the workspace folder. Changing it re-indexes. Files in skipped folders are still loaded when something includes them. |
| `glslLsp.index.maxFiles` | `10000` | Maximum number of indexed files per workspace folder. |
| `glslLsp.trace.server` | `off` | Trace LSP traffic in the output channel. |

Commands: **GLSL: Restart Language Server**, **GLSL: Show Language Server
Output**, **GLSL: Re-index Workspace**.

> A folder that contains a file named `.glsl-lsp-ignore` is never indexed.
> This repository's `test/fixtures/` has one, so its fixtures do not show up as
> completion candidates when the repository sits inside a shader workspace (as
> a submodule). Add the marker to any folder of GLSL files you want ignored.
>
> Recognized file extensions: `.glsl`, `.frag`, `.vert`, `.comp`, `.geom`,
> `.tesc`, `.tese`. `.fs`/`.vs` are not claimed (they are F# and other
> languages too); map them with `files.associations` if they are shaders in
> your project.

## Relation to other extensions

- **[shader-toy](https://marketplace.visualstudio.com/items?itemName=stevensona.shader-toy)**
  (stevensona) renders the preview. This extension understands its
  directives (`#include`, `#iChannelN`, `#iUniform`, `#iKeyboard`) and uniforms
  but does not render anything. The two work side by side. You may want to
  turn off `shader-toy.showCompileErrorsAsDiagnostics` if both report the
  same compile errors.
- **Wallpaper Kit** (the sibling `extension/` folder of the shader
  workspace) runs shaders in the wallpaper engine. It also contributes the
  `glsl` language id and a grammar. Several extensions contributing the same
  language id is normal in VS Code: they are merged. The language server works
  with either grammar. If the highlighting looks different from what you
  expect, the last grammar registered wins; disable the other extension's
  grammar or this one's as you prefer.

## Install

From source:

```sh
npm install
npm run package                      # builds (minified) and writes glsl-lsp-<version>.vsix
code --install-extension glsl-lsp-0.1.0.vsix
```

`glslangValidator` is optional. Install it from the Vulkan SDK or MSYS2's
`mingw-w64-glslang`, or point `glslLsp.diagnostics.glslang.path` at it.

## Development

```sh
npm install
npm run watch        # rebuild dist/ on change
npm run typecheck
npm test             # unit tests + real-workspace tests (skipped when ../lygia is absent)
npm run test:e2e     # just the end-to-end test: spawns dist/server.js over stdio
```

Press F5 in VS Code (**Run Extension**) to start an Extension Development
Host on the parent folder. Use the **Extension + Server** compound
configuration to also attach a debugger to the server (port 6009).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, the data model and
a step-by-step guide to adding a feature.

## License

MIT
