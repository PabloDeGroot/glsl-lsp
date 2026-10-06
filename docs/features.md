# Editing features

Everything the language server does while you edit GLSL, in detail.

[← Back to README](../README.md)

On macOS, read Ctrl as Cmd in the shortcuts below (Cmd+T, Cmd+click), except
Ctrl+Space, which stays Ctrl+Space.

- [Hover with your doc comments](#hover-with-your-doc-comments)
- [Completion with automatic `#include`](#completion-with-automatic-include)
- [Signature help and inlay hints](#signature-help-and-inlay-hints)
- [Navigation, references and rename](#navigation-references-and-rename)
- [Symbols](#symbols)
- [Code actions](#code-actions)
- [Highlighting, folding and selection](#highlighting-folding-and-selection)
- [Color decorators](#color-decorators)
- [Diagnostics, formatting and the Values panel](#diagnostics-formatting-and-the-values-panel)

## Hover with your doc comments

Hovering a function, struct, macro, uniform, variable or `#include` path
shows every overload's signature, its documentation rendered as Markdown,
and where it is defined.

![Hover on the LYGIA function boxSDF showing both overloads, its description, a Usage block, contributors and the defining file](../images/hover.png)

Two doc comment styles are understood. Plain comments directly above a
declaration:

```glsl
// Centered and aspect corrected: y spans [-1, 1], x spans [-aspect, aspect].
// This is the coordinate space you want for almost everything.
vec2 uvCentered(vec2 fragCoord, vec2 res) { ... }
```

And LYGIA-style YAML blocks, usually at the top of a file:

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

- **`//` and `/* */` comments** directly above a declaration document it. A
  blank line between the comment and the declaration breaks the link.
- **Trailing `// comments`** document variables, struct fields, parameters,
  `#define`s and `#iUniform`s.
- **LYGIA YAML blocks** apply to every function, struct and function-like
  macro in the file that has no doc comment of its own. They are shown as
  the description, a *Usage* code block, *Options* and *Examples*. An option
  macro such as `GNOISE_NOISE_FNC` shows its own line from `options:`.
- **Builtins** have docs and a link to the Khronos reference page: about 180
  GLSL function families with every overload, the `gl_*` variables, types,
  qualifiers, and the Shadertoy uniforms where
  [Shadertoy support](configuration.md#shadertoy-integration-optional) applies.
- **Environment uniforms and defines** you declare in the settings show their
  type and your Markdown doc. See
  [Environment](configuration.md#environment).
- If a symbol exists in the workspace but is **not included** in the current
  file, the hover says which `#include` would bring it in.

## Completion with automatic `#include`

Start typing the name of a function, struct or macro (or press Ctrl+Space)
and pick it from the list.
If it lives in a file that the current shader does not include yet, directly
or through other includes, the matching `#include` line is added for you.

![Typing snoi lists the LYGIA functions snoise, snoise2 and snoise3 with their file paths; accepting one adds the include at the top of the shader](../images/autoinclude.gif)

```glsl
#version 330 core
#include "../lygia/generative/snoise.glsl"   // <- inserted when you accept `snoise`

uniform vec2 u_resolution;
out vec4 fragColor;

void main() {
    float n = snoise(gl_FragCoord.xy / u_resolution.y * 4.0);
```

Turn this off with `glslLsp.completion.autoInclude`.

### Where the `#include` goes

- The path is written relative to the current file. It uses `<...>` when
  every existing include does, and it keeps CRLF line endings.
- The new line goes after the last top-level `#include` (not one inside an
  `#if` block or below code).
- With no includes yet, it goes after all of these at the top of the file:
  - `#version`, `#extension` and `#pragma` lines, and `precision`
    statements;
  - shader-toy directives such as `#iChannel0` and `#iUniform`;
  - an include guard;
  - `#define`s (LYGIA options must come before the library's include);
  - `#ifndef X` / `#define X 4` / `#endif` defaults;
  - a header comment that is followed by a blank line.

  A comment directly above the first declaration is that declaration's doc
  comment, so it stays attached to it.

### What is offered

- With an empty prefix (Ctrl+Space), up to 300 not-yet-included functions and
  structs are listed, in this order:
  1. files in a `lib/` folder, if you have one;
  2. LYGIA's `generative`, `math`, `color`, `sdf`, `draw` and `space` folders;
  3. the rest of LYGIA;
  4. all other files;
  5. test and fixture folders, last.

  Within each group, shorter paths come first.

  Typing narrows the full set, not just those 300.
- If one of your own library files already includes the defining LYGIA file
  (for example a `lib/noise.glsl` that includes LYGIA's file defining
  `gnoise`), your library is offered first. Another shader's multipass
  `common.glsl` (only included by the shaders next to it) is never offered as
  such a library.
- Nothing is offered where you are naming a new variable, parameter or field
  (`float gno|`).
- Never offered: symbols that are already reachable, LYGIA option macros, and
  include targets that are shader entry points (files defining `mainImage` or
  `main`) or that include the current file (that would be a cycle). You still
  get auto-include while editing an entry point; it just never includes one.

### The rest of completion

Completion is context aware:

- **Identifiers:** locals in scope, then this file, then included files, then
  builtins, then keywords.
- **Members after `.`:** swizzles limited to the vector size (`xyzw`, `rgba`,
  `stpq`), struct fields, and `length()` on arrays.
- **Preprocessor:** directive snippets after `#`, file and folder paths inside
  `#include "`, macro names after `#ifdef`, `#version` profiles and
  `#extension` names.
- **Functions** insert `name($0)` and open signature help.

## Signature help and inlay hints

![Signature help for smoothstep showing overload 2 of 4 with the active parameter highlighted and a Khronos reference link, with edge0 and edge1 inlay hints on the arguments](../images/signature.png)

**Signature help** shows every overload, with the active parameter,
per-parameter docs, struct and `vecN`/`matN` constructors, and function-like
macros. The best overload is picked by argument count and types.

**Inlay hints** show parameter names on literal arguments, for example
`smoothstep(edge0: 0.2, edge1: 0.8, d)`. `glslLsp.inlayHints.parameterNames`
chooses `none`, `literals` (the default) or `all`.

## Navigation, references and rename

- **Go to definition, declaration and type definition** work into included
  files and libraries such as LYGIA. The overload is picked by argument count
  and types. Ctrl+click on an `#include` path opens the file.
- **References, document highlight and rename** are scope-aware: locals never
  leak, and in `float d = d * 2.0;` the right-hand `d` is the outer one. They
  work across included files, including overloads split between a library and
  the file that includes it.
- **Rename refuses** builtins, keywords, reserved words (`class`, `input`,
  `gl_*`, `a__b`) and symbols declared in read-only folders, and says why. The
  read-only folders are set with `glslLsp.rename.readOnlyPaths` (LYGIA by
  default). Files outside the workspace folders are read-only unless they are
  open in an editor.

## Symbols

- **Document symbols:** the Outline view and breadcrumbs, with struct fields.
- **Workspace symbols:** fuzzy search (Ctrl+T) over every top-level function,
  struct, macro and global variable in the workspace.

## Code actions

![The undeclared call snoise(uv) underlined, with the Quick Fix Add #include "../lygia/generative/snoise.glsl"](../images/quickfix.png)

- **Add `#include "..."`** for an undeclared name that a workspace file
  defines. When one of your own library files brings the name in through its
  own includes, that library is offered too, with `(provides snoise)` in the
  title.
- **Change to `"..."`** for an include that can't be found, when a file with
  the same name exists elsewhere in the workspace.
- **Remove unused `#include`**, and **Remove redundant `#include`** when the
  file is already included through another `#include`.

## Highlighting, folding and selection

- **Semantic highlighting:** functions, parameters, globals, uniforms
  (`readonly`), struct fields, macros and builtins (`defaultLibrary`).
- **Syntax highlighting:** a TextMate grammar that also knows shader-toy
  directives, LYGIA doc keys and macro constants. If another GLSL extension is
  installed too, see
  [Other GLSL extensions](configuration.md#other-glsl-extensions).
- **Comment continuation:** Enter on a `//` or `///` comment line continues
  the comment; inside a `/** */` block it adds ` * `.
- **Folding:** braces, `#if` / `#else` branches, comment blocks, runs of
  `#include`s and `// region` / `// endregion` markers.
- **Smart selection:** Expand Selection steps out from word to argument, call,
  statement, block and function.

## Color decorators

A color swatch and VS Code's color picker appear on `vec3(1.0, 0.5, 0.2)`
style literals that are clearly colors, on `#define` color constants and on
`#iUniform color3` defaults. `glslLsp.colors.mode` chooses `heuristic` (the
default), `all` (every `vec3`/`vec4` literal in [0, 1]) or `off`.

For sliders, an HDR-aware color picker and other widgets that edit values as
you drag, see the [Values panel](values-panel.md).

## Diagnostics, formatting and the Values panel

These have their own pages:

- [Diagnostics](diagnostics.md): fast in-process checks as you edit, and
  full compiler errors from `glslangValidator`.
- [Formatting](formatting.md): Format Document, Format Selection and format
  on type, with a conservative default that keeps hand-aligned code.
- [Values panel](values-panel.md): sliders, color pickers, trackpads and a
  cosine palette editor for the numbers in your shader.

All settings are listed in [Configuration](configuration.md).
