# GLSL Language Server

A modern language server and VS Code extension for GLSL: plain `.vert` /
`.frag` / `.comp` shaders, large include-based libraries such as
[LYGIA](https://lygia.xyz), and, optionally, Shadertoy-style shaders. Uniforms
and macros your own runtime provides can be declared in the settings so they
behave like builtins (see [Environment](#environment)).

It ships as one extension: a small client (`dist/client.js`) that starts the
bundled language server (`dist/server.js`), plus the **Values** side panel
(`dist/webview.js`/`.css`) with sliders and color/vector pickers for the
numbers in your shader. There is no runtime dependency
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
  structs are listed: files in a `lib/` folder (if you have one) first, then
  LYGIA's generative, math, color, sdf, draw and space folders, then shorter
  paths; test and fixture folders last. Typing narrows the full set.
- If one of your own library files already includes the defining LYGIA file
  (for example a `lib/noise.glsl` that includes LYGIA's file defining `gnoise`), that library is offered
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
| **Go to definition / declaration / type definition** | Into included files and libraries such as LYGIA. The overload is picked by argument count and types. Ctrl+click on an `#include` path opens the file. |
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
   - Shadertoy-style files (where [Shadertoy support](#shadertoy-integration-optional)
     applies) are wrapped in the shader-toy extension's WebGL2 preamble
     (uniforms, `iChannel0-3` with their `#iChannel` types, `#iKeyboard`
     helpers, `#iUniform`s) and a generated `main()`.
   - The [environment](#environment) uniforms and defines are declared too:
     after the Shadertoy preamble, or right after `#version` in plain GLSL.
   - Includes are inlined. Errors inside an included file are reported on that
     file, plus a summary on the `#include` line.
   - Library files without `main`/`mainImage` are checked through the shaders
     that include them.

### Values panel: sliders, color and vector pickers

The **GLSL** icon in the Activity Bar opens the **Values** panel: interactive
widgets for the numbers in your shader, in the spirit of
[glslEditor](https://github.com/patriciogonzalezvivo/glslEditor). Dragging a
widget rewrites the literal in the document live (about 30 times a second),
so a live preview (such as shader-toy's) updates as you drag. Each drag is
**one undo step**.

The panel has two parts.

**1. The values list**

- **Cursor** (always the first row): the value under or nearest the editor
  cursor, such as a float literal, a `vec2/vec3/vec4` constructor, an
  `#iUniform` default, a `#define` or an iq cosine palette. It follows the
  cursor as you move.
- **Pinned**: values you keep at hand while you edit elsewhere. Each row shows
  a name (variable, uniform or a short code snippet), the file when it is not
  the active one, and a live preview: color swatch, numbers or a small arrow.
  - **Pin**: click the pin button on the cursor row, run **GLSL: Pin Value at
    Cursor** (also in the editor right-click menu and the panel title bar), or
    press `P` in the list.
  - **Unpin**: the × on the row, `Delete` in the list, or **GLSL: Unpin All
    Values** from the panel title bar.
  - Pins are saved per workspace and found again by declaration name
    (`#iUniform u_speed`, `const float K`, a local `col`), otherwise by the
    shape of the line. They survive edits above them and value changes. A pin
    whose value was deleted shows *not found* instead of jumping to another
    value.
  - A pin in another file keeps working: dragging edits that file even when it
    is not open in an editor.
- Drag a number sideways in the list to scrub it; double-click it to type.
  Lines with several numbers and palettes expand into one sub-row per value.

**2. The widget** for the selected row. It is the cursor row unless you click
a pin; a selected pin stays selected while the cursor moves. Click the cursor
row, **← Back to cursor** or press `Escape` to go back.

| Value | Widget |
| --- | --- |
| `float` | Slider and number field. The range comes from `#iUniform ... in { min, max }`, otherwise an automatic range around the value that you can edit. Shift drags finely; double-click resets. |
| `vec2` | 2D trackpad with grid and axes, editable range, X/Y fields. Shift is fine, Ctrl snaps, Ctrl+wheel zooms. |
| `vec3`/`vec4` color | Saturation/brightness square, hue strip, alpha strip for `vec4`, hex and RGB(A) fields, intensity slider for HDR values above 1. Used for `#iUniform color3`, names like `col`/`tint`/`rgb` and the existing color heuristic. |
| `vec3`/`vec4` direction | Trackball: drag to rotate the vector, with *Keep length* or *Normalize*. Shift snaps to 15°, Ctrl to axes. |
| Several numbers on a line | One slider per number. |
| iq palette `palette(t, a, b, c, d)` or `a + b*cos(6.28318*(c*t+d))` | Gradient strip, r/g/b curves, a/b/c/d rows and presets. |

A **Color | Vector** toggle switches a `vec3`/`vec4` between the two widgets.
Non-literal components (`vec3(t, 0.5, 1.0)`) show as locked. Floats always
keep a `.` (`2.0`), trailing zeros are trimmed, and the precision follows the
widget step (at most `glslLsp.values.maxDecimals`). If you type in the same
spot while dragging, the drag stops instead of overwriting your edit.

Keyboard in the panel: `↑`/`↓` move through rows, `→`/`←` expand and
collapse, `Enter` reveals the value in the editor, `P` pins or unpins,
`Delete` unpins, `Alt+↑`/`Alt+↓` reorder pins, `Escape` goes back to the
cursor. Arrow keys adjust a focused slider or trackpad (several presses in a
row are one undo step).

**Nudge the number under the cursor** without the panel:

| Command | Keybinding (GLSL editors) |
| --- | --- |
| GLSL: Increment Number at Cursor | `Ctrl+Alt+Up` |
| GLSL: Decrement Number at Cursor | `Ctrl+Alt+Down` |
| GLSL: Increment Number at Cursor (x10) | `Ctrl+Shift+Alt+Up` |
| GLSL: Decrement Number at Cursor (x10) | `Ctrl+Shift+Alt+Down` |

The step is the literal's last decimal place (`0.25` steps by `0.01`, `3` by
`1`), and it works with multiple cursors.

> On Windows, `Ctrl+Alt+Up/Down` is VS Code's *Add Cursor Above/Below*; on
> Windows and Linux `Ctrl+Shift+Alt+Up/Down` is column selection. In a GLSL
> editor the keys nudge only when the cursor is on a number (with several
> cursors: when every cursor is on a number); otherwise they fall back to
> the platform's default command, so adding cursors keeps working.
> To use other keys, rebind `glslLsp.nudgeUp`/`glslLsp.nudgeDown` in
> **Keyboard Shortcuts** (Ctrl+K Ctrl+S). (Some Windows graphics drivers
> grab `Ctrl+Alt+Arrow` to rotate the screen before VS Code sees it.)

**GLSL: Pin Value at Cursor** reveals the panel if it has been opened before.
If it has never been opened, the value is pinned anyway and the status bar
says so; open the **GLSL** view to see it.

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
| `glslLsp.shadertoy.enable` | `auto` | Where Shadertoy support applies: `auto`, `on` or `off` (legacy `true`/`false` mean `on`/`off`). See [Shadertoy integration](#shadertoy-integration-optional). |
| `glslLsp.environment.uniforms` | `[]` | Uniforms your runtime provides: `{ name, type, doc? }`. See [Environment](#environment). |
| `glslLsp.environment.defines` | `{}` | Macros your runtime defines: `{ "NAME": "value" }`. See [Environment](#environment). |
| `glslLsp.index.exclude` | `["node_modules", ".git", "out", "dist", ".vscode-test"]` | Folders skipped when indexing. A bare name matches anywhere; an entry containing `/` (e.g. `vendor/old`) matches a path relative to the workspace folder. Changing it re-indexes. Files in skipped folders are still loaded when something includes them. |
| `glslLsp.index.maxFiles` | `10000` | Maximum number of indexed files per workspace folder. |
| `glslLsp.values.throttleMs` | `33` | Minimum milliseconds between document edits while dragging a Values widget (33 ms is about 30 per second). Raise it if the live preview stutters. |
| `glslLsp.values.maxDecimals` | `4` | Maximum decimals written by the Values panel. Trailing zeros are trimmed. A literal that already has more decimals keeps its precision, and a value too small for the limit is written with an exponent (`1e-5`) rather than rounded to `0.0`. |
| `glslLsp.values.followCursor` | `true` | Update the Values panel's cursor row as the cursor moves. When off, it updates when you switch editors or run **GLSL: Focus Values Panel**. |
| `glslLsp.trace.server` | `off` | Trace LSP traffic in the output channel. |

Commands: **GLSL: Restart Language Server**, **GLSL: Show Language Server
Output**, **GLSL: Re-index Workspace**, **GLSL: Pin Value at Cursor**,
**GLSL: Unpin All Values**, **GLSL: Focus Values Panel**, the four nudge
commands (see [Values panel](#values-panel-sliders-color-and-vector-pickers))
and **GLSL: Show Shadertoy Preview** (only when the shader-toy extension is
installed).

> A folder that contains a file named `.glsl-lsp-ignore` is never indexed.
> Add the marker to any folder of GLSL files you want ignored (vendored copies,
> old experiments, test data).
>
> Recognized file extensions: `.glsl`, `.frag`, `.vert`, `.comp`, `.geom`,
> `.tesc`, `.tese`. `.fs`/`.vs` are not claimed (they are F# and other
> languages too); map them with `files.associations` if they are shaders in
> your project.

## Shadertoy integration (optional)

Shadertoy support covers the Shadertoy uniforms (`iTime`, `iResolution`,
`iMouse`, `iChannel0-3`, ...) and entry points (`mainImage`, `mainSound`,
`mainVR`), the directives of the
[shader-toy](https://marketplace.visualstudio.com/items?itemName=stevensona.shader-toy)
extension (`#iChannelN`, `#iUniform`, `#iKeyboard` with its `isKeyDown` /
`Key_*` helpers, the `iMouseButton` uniform) and validating `mainImage`
shaders inside a generated `main()`. `glslLsp.shadertoy.enable` decides where
it applies:

| Value | Shadertoy support for |
| --- | --- |
| `auto` (default) | Files that define `mainImage` or use a shader-toy directive, plus the files they include and the files including them. Every GLSL file when the shader-toy extension is installed. Elsewhere, a library may still use Shadertoy names without a report (a Shadertoy shader may include it later), but a plain entry shader that defines `main()` gets them reported as undeclared. |
| `on` | Every GLSL file. |
| `off` | No file: plain GLSL only. `mainImage` files are validated as ordinary GLSL (no generated `main`), and Shadertoy names are reported as undeclared. |

The shader-toy extension itself is **not required**: nothing depends on it,
and everything above works without it. When it is installed, this extension
adds **GLSL: Show Shadertoy Preview** to the command palette and a preview
button to the editor title bar of GLSL files. Both run the shader-toy
extension's own *Show GLSL Preview* command; they are hidden when the
extension is not installed. This extension never renders anything itself.
You may want to turn off `shader-toy.showCompileErrorsAsDiagnostics` if both
report the same compile errors.

## Environment

Shaders often run in a host that provides more than GLSL: a custom player,
a game engine, a live-coding tool. Declare what it provides and the names
behave like builtins: hover (signature and your Markdown doc, labelled
*Environment uniform* / *Environment define*), completion, semantic
highlighting, typing of members and indexes (`trail[0].xy`), no
undeclared-identifier report, and declarations for `glslangValidator`.

```jsonc
// .vscode/settings.json of a project whose runtime adds a cursor trail and a light count
{
  "glslLsp.environment.uniforms": [
    { "name": "iCursorTrail", "type": "vec2[8]", "doc": "The last 8 cursor positions in pixels, newest first." },
    { "name": "iAudioLevel", "type": "float", "doc": "Smoothed audio input level in `[0, 1]`." }
  ],
  "glslLsp.environment.defines": {
    "MY_RUNTIME": "",
    "MAX_LIGHTS": "8"
  }
}
```

- `type` is a builtin GLSL type (`float`, `vec4`, `mat3`, `sampler2D`, ...);
  arrays are written `type[size]` (`vec4[16]`).
- Invalid entries are ignored: names that are not valid identifiers (keywords,
  reserved words, `gl_` / `__` names), unknown types, duplicates. Define
  values are kept on one line and lose a trailing `\`.
- A uniform or define the shader declares itself wins: the environment's
  copy is not passed to `glslangValidator`, so there is no redefinition error.
  A uniform named like a Shadertoy builtin replaces that builtin.
- With Shadertoy support the declarations follow the Shadertoy preamble; in
  plain GLSL they go right after `#version` (`highp` in GLSL ES).
- Changes apply immediately: diagnostics and highlighting refresh without a
  restart.

## Relation to other extensions

- **shader-toy** (stevensona): see
  [Shadertoy integration](#shadertoy-integration-optional).
- **Other GLSL extensions** may also contribute the `glsl` language id and a
  grammar. Several extensions contributing the same language id is normal in
  VS Code: they are merged, and this language server works with either
  grammar. If the highlighting looks different from what you expect, the last
  grammar registered wins; disable the other extension's grammar or this
  one's as you prefer.

## Install

From source:

```sh
npm install
npm run package                      # builds (minified) and writes glsl-lsp-<version>.vsix
code --install-extension glsl-lsp-0.3.0.vsix
```

`glslangValidator` is optional. Install it from the Vulkan SDK or MSYS2's
`mingw-w64-glslang`, or point `glslLsp.diagnostics.glslang.path` at it.

## Development

```sh
npm install
npm run watch        # rebuild dist/ on change
npm run typecheck
npm test             # unit tests + real-workspace tests (skipped without a shader workspace)
npm run test:e2e     # just the end-to-end test: spawns dist/server.js over stdio
```

The real-workspace tests run against a real shader workspace, e.g. one with
LYGIA: the folder in `GLSL_LSP_E2E_ROOT` (an error if it does not exist), or
this repository's parent folder. Either is used only when it looks like a
shader workspace (a `lygia/` folder, or `.glsl` files at the top or one folder
down); otherwise those tests are skipped. They never modify it.

`test/fixtures/` holds a `.glsl-lsp-ignore` marker, so when this repository
is cloned inside a shader workspace its fixtures do not show up as completion
candidates there.

Press F5 in VS Code (**Run Extension**) to start an Extension Development
Host on `test/fixtures/project`. Use the **Extension + Server** compound
configuration to also attach a debugger to the server (port 6009).

The Values panel UI can be checked without VS Code: run `npm run build`, then
open `webview/dev/harness.html?theme=dark&scene=color` in a browser (themes
`dark`, `light`, `hc`; scenes `color`, `float`, `vec2`, `vector`, `vec4`,
`palette`, `multi`, `stale`, `empty`, `noEditor`, `hdr`, `locked`,
`childColor`; `&w=320` sets the width, `&selftest=1` runs a scripted check of
the messages it sends). The harness fakes the VS Code API and is not shipped.
The panel's full design is in [docs/VALUES.md](docs/VALUES.md).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, the data model and
a step-by-step guide to adding a feature.

## License

MIT
