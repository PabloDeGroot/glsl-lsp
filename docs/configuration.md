# Configuration

Every setting and command, plus runtime uniforms, Shadertoy support, indexing and file extensions.

[← Back to README](../README.md)

- [Settings](#settings)
- [Environment: your runtime's uniforms and defines](#environment)
- [Shadertoy integration (optional)](#shadertoy-integration-optional)
- [Includes](#includes)
- [Indexing](#indexing)
- [File extensions](#file-extensions)
- [Commands](#commands)
- [Other GLSL extensions](#other-glsl-extensions)
- [Remote and web](#remote-and-web)

Everything works without configuration. Settings can be set per user or per
workspace (`.vscode/settings.json`). Open them with **Preferences: Open
Settings** and search for `glslLsp`.

## Settings

### Includes and editing

| Setting | Default | Description |
| --- | --- | --- |
| `glslLsp.includePaths` | `[]` | Extra include directories (absolute, or relative to each workspace folder). See [Includes](#includes) for the search order. |
| `glslLsp.completion.autoInclude` | `true` | Offer symbols from files that are not included yet, and insert their `#include` when you accept one. |
| `glslLsp.rename.readOnlyPaths` | `["lygia"]` | Folders a rename never edits. Renaming a symbol declared there is refused. A bare name matches that folder anywhere; an entry containing `/` matches a path relative to the workspace folder. Files outside the workspace folders are read-only unless they are open in an editor. |
| `glslLsp.inlayHints.parameterNames` | `literals` | Parameter name hints on call arguments: `none`, `literals` (literal and constructor arguments such as `0.5` or `vec2(1.0)`) or `all`. |
| `glslLsp.colors.mode` | `heuristic` | Which `vec3(...)` / `vec4(...)` literals get a color swatch and picker: `heuristic` (literals that look like colors), `all` (every literal with components in [0, 1]) or `off`. |

### Diagnostics

See [Diagnostics](diagnostics.md) for what each layer checks.

| Setting | Default | Description |
| --- | --- | --- |
| `glslLsp.diagnostics.enable` | `true` | Master switch for all diagnostics. |
| `glslLsp.diagnostics.undeclared` | `true` | Report undeclared identifiers. A name declared in a workspace file you don't include is an error with an *Add #include* quick fix. |
| `glslLsp.diagnostics.onType` | `true` | Re-run all diagnostics while typing (debounced). When off, files are checked when opened and saved. Changes on disk always re-check the open files that depend on them. |
| `glslLsp.diagnostics.glslang.enable` | `true` | Compile shaders with `glslangValidator` and report its errors. Set to `false` if you don't have it installed and don't want it. |
| `glslLsp.diagnostics.glslang.path` | `glslangValidator` | The `glslangValidator` executable: a name looked up on `PATH` (never in the workspace folder), an absolute path, or a path relative to the first workspace folder (trusted workspaces only). A `.cmd`/`.bat` wrapper works on Windows. In Restricted Mode only your user setting is used. |
| `glslLsp.diagnostics.glslang.targetEnv` | `auto` | The rules `glslangValidator` applies: `auto` (Vulkan 1.2 for shaders that use Vulkan-only GLSL, OpenGL otherwise), `opengl`, or `vulkan1.0` to `vulkan1.3`. See [OpenGL or Vulkan rules](diagnostics.md#what-gets-passed-to-the-compiler). |

### Runtime

| Setting | Default | Description |
| --- | --- | --- |
| `glslLsp.environment.uniforms` | `[]` | Uniforms your runtime provides, as `{ "name", "type", "doc"? }`. See [Environment](#environment). |
| `glslLsp.environment.defines` | `{}` | Macros your runtime defines, as `{ "NAME": "value" }`. See [Environment](#environment). |
| `glslLsp.environment.presets` | `[]` | Names a framework injects: `["three.js"]` adds the `ShaderMaterial` uniforms and attributes and stops reporting `#include <chunk>`. See [three.js](diagnostics.md#threejs-and-other-runtimes-that-inject-code). |
| `glslLsp.shadertoy.enable` | `auto` | Where Shadertoy support applies: `auto`, `on` or `off`. See [Shadertoy integration](#shadertoy-integration-optional). |

### Workspace index

| Setting | Default | Description |
| --- | --- | --- |
| `glslLsp.index.exclude` | `["node_modules", ".git", "out", "dist", ".vscode-test"]` | Folders skipped when indexing. See [Indexing](#indexing). |
| `glslLsp.index.maxFiles` | `10000` | Maximum number of GLSL files indexed in total, across all workspace folders. |

### Values panel

See [Values panel](values-panel.md).

| Setting | Default | Description |
| --- | --- | --- |
| `glslLsp.values.throttleMs` | `33` | Minimum milliseconds between document edits while dragging a widget (33 ms is about 30 edits per second). Raise it if a live preview stutters. |
| `glslLsp.values.maxDecimals` | `4` | Maximum decimals written into a float literal. Trailing zeros are trimmed (`0.5`, `2.0`). A literal that already has more decimals keeps its precision, and a value too small for the limit is written with an exponent (`1e-5`) instead of `0.0`. |
| `glslLsp.values.followCursor` | `true` | Update the panel's cursor row as the editor cursor moves. When off, it updates when you switch editors or run **GLSL: Focus Values Panel**. |

### Formatting

See [Formatting](formatting.md) for the rules of each mode and how to format on save.

| Setting | Default | Description |
| --- | --- | --- |
| `glslLsp.format.mode` | `conservative` | `conservative` (indentation and whitespace only), `opinionated` or `off`. |
| `glslLsp.format.maxBlankLines` | `1` | Longest run of consecutive blank lines the formatter keeps. |
| `glslLsp.format.braceStyle` | `preserve` | Where the `{` of a block goes: `preserve`, `sameLine` or `nextLine`. Only used in `opinionated` mode. |
| `glslLsp.format.indentPreprocessor` | `false` | Indent preprocessor lines (`#ifdef`, `#define`, ...) to the brace depth of the surrounding code. |

### Troubleshooting

| Setting | Default | Description |
| --- | --- | --- |
| `glslLsp.trace.server` | `off` | Trace the messages between VS Code and the language server in its output channel: `off`, `messages` or `verbose`. |

## Environment

Shaders often run in a host that provides more than GLSL: a game engine, a
custom player, a creative-coding tool, a live-coding setup. Declare what it
provides and those names behave like builtins:

- hover shows the type and your Markdown doc, labelled *Environment uniform*
  or *Environment define*;
- they appear in completion and get semantic highlighting;
- members and indexes are typed (`u_lights[0].xyz` is a `vec3`);
- they are never reported as undeclared;
- they are declared for `glslangValidator`, so compiler checks pass too.

```jsonc
// .vscode/settings.json of a project whose engine injects time, resolution and a light array
{
  "glslLsp.environment.uniforms": [
    { "name": "u_time", "type": "float", "doc": "Seconds since the scene started." },
    { "name": "u_resolution", "type": "vec2", "doc": "Viewport size in pixels." },
    { "name": "u_lights", "type": "vec4[8]", "doc": "Point lights: `xyz` position, `w` intensity." }
  ],
  "glslLsp.environment.defines": {
    "MY_ENGINE": "",
    "MAX_LIGHTS": "8"
  }
}
```

Rules:

- `type` is a builtin GLSL type (`float`, `vec4`, `mat3`, `sampler2D`, ...).
  Arrays are written `type[size]`, for example `vec4[16]`.
- Invalid entries are ignored: names that are not valid identifiers
  (keywords, reserved words, uniform names starting with `gl_`, define names
  starting with `GL_`, names containing `__`), unknown types and duplicates
  (the first entry wins).
- Define values are kept on one line and lose a trailing `\`. A value may be
  `""`. Numbers and booleans are accepted too.
- A uniform or define the shader declares itself wins: the environment's copy
  is not passed to `glslangValidator`, so there is no redefinition error. A
  uniform named like a builtin (a Shadertoy uniform, for example) replaces it
  in hover and completion; the Shadertoy preamble still declares its own copy
  for `glslangValidator`.
- For `glslangValidator`, the declarations go right after `#version` in plain
  GLSL (with `highp` in GLSL ES), or after the Shadertoy preamble where
  Shadertoy support applies.
- Changes apply immediately: diagnostics and highlighting refresh without a
  restart.

For three.js, set `"glslLsp.environment.presets": ["three.js"]` instead of
listing its names; see
[Diagnostics: three.js](diagnostics.md#threejs-and-other-runtimes-that-inject-code).

## Shadertoy integration (optional)

Shadertoy support covers:

- the Shadertoy uniforms (`iTime`, `iResolution`, `iMouse`, `iChannel0-3`, ...)
  and entry points (`mainImage`, `mainSound`, `mainVR`);
- the directives of the
  [shader-toy](https://marketplace.visualstudio.com/items?itemName=stevensona.shader-toy)
  extension: `#iChannelN`, `#iUniform`, `#iKeyboard` with its `isKeyDown` /
  `Key_*` helpers, and the `iMouseButton` uniform;
- compiling `mainImage` shaders with `glslangValidator` inside a generated
  `main()`.

`glslLsp.shadertoy.enable` decides where it applies:

| Value | Shadertoy support for |
| --- | --- |
| `auto` (default) | Files that define `mainImage` or use a shader-toy directive, plus the files they include and the files that include them. Every GLSL file when the shader-toy extension is installed. Elsewhere, a library may use Shadertoy names without a report (a Shadertoy shader may include it later), but a plain shader that defines `main()` gets them reported as undeclared. |
| `on` | Every GLSL file. |
| `off` | No file: plain GLSL only. `mainImage` files get no generated `main()`, so they are compiled only if they have their own `main()` and `#version`. Shadertoy names are reported as undeclared. |

The legacy values `true` and `false` still work and mean `on` and `off`.

The shader-toy extension itself is **not required**. Nothing depends on it,
and everything above works without it. When it is installed, this extension
adds **GLSL: Show Shadertoy Preview** to the Command Palette and a preview
button to the editor title bar of GLSL files. Both run the shader-toy
extension's own *Show GLSL Preview* command and are hidden when it is not
installed. This extension never renders shaders itself.

If both extensions report the same compile errors, turn off
`shader-toy.showCompileErrorsAsDiagnostics`.

## Includes

`#include "path"` is resolved by looking in, in order:

1. the folder of the file that contains the `#include`;
2. each entry of `glslLsp.includePaths` (absolute, or relative to each
   workspace folder);
3. the root of each workspace folder.

So with LYGIA cloned at the top of your workspace, `#include
"lygia/generative/snoise.glsl"` works from a file at any depth without any
configuration. An absolute path is used as is.

## Indexing

On startup the extension reads every GLSL file in the workspace, so that
workspace symbol search, auto-include completion and cross-file navigation
know about them. These folders are skipped:

- any folder named in `glslLsp.index.exclude`. A bare name (`node_modules`)
  matches that folder anywhere; an entry containing `/` (`vendor/old`)
  matches a path relative to the workspace folder, or the end of one.
  Changing the setting re-indexes.
- any folder whose name starts with `.`;
- any folder that contains a file named `.glsl-lsp-ignore`. Add this empty
  marker to vendored copies, old experiments or test data you don't want in
  completion and search.

Files in skipped folders are still read when something includes them.

`glslLsp.index.maxFiles` (default `10000`) caps the total number of indexed
files across all workspace folders of a multi-root workspace.

Run **GLSL: Re-index Workspace** if the index ever looks stale.

## File extensions

These extensions open as GLSL: `.glsl`, `.frag`, `.vert`, `.comp`, `.geom`,
`.tesc`, `.tese`, `.vsh`, `.fsh`, `.gsh`, `.vshader`, `.fshader`, `.gshader`,
`.glslv`, `.glslf` and `.glslg`. A file whose extension no installed
language claims is detected as GLSL when its first line is a `#version`
directive.

Not claimed, because other languages or binary files use them: `.vs`, `.fs`
(F#), `.gs` (Google Apps Script), `.cs` (C#), `.shader` (Unity), `.mesh` and
`.task`. The Vulkan ray tracing extensions (`.rgen`, `.rchit`, ...) are not
claimed yet either (see
[Vulkan GLSL](diagnostics.md#vulkan-glsl)). If some of them are shaders in
your project, map them in `.vscode/settings.json`:

```jsonc
{
  "files.associations": {
    "*.vs": "glsl",
    "*.fs": "glsl"
  }
}
```

Mapped files get every feature while they are open, and `glslangValidator`
picks the right stage from the extension (see
[Diagnostics](diagnostics.md#what-gets-passed-to-the-compiler)). The
workspace index only scans the extensions listed first, so a mapped file that
is not open does not show up in workspace symbol search or as an auto-include
candidate. It is still read when something includes it.

## Commands

Open the Command Palette (Ctrl+Shift+P, Cmd+Shift+P on macOS) and type `GLSL`.

| Command | What it does |
| --- | --- |
| **GLSL: Restart Language Server** | Restart the server, for example after installing `glslangValidator`. |
| **GLSL: Show Language Server Output** | Open the server's log. |
| **GLSL: Re-index Workspace** | Read every GLSL file in the workspace again. |
| **GLSL: Focus Values Panel** | Open the [Values panel](values-panel.md) and refresh it for the cursor. |
| **GLSL: Pin Value at Cursor** | Keep the value under the cursor in the Values panel (also in the editor context menu). |
| **GLSL: Unpin All Values** | Remove all pins. |
| **GLSL: Increment Number at Cursor** | Nudge the number under the cursor up. Ctrl+Alt+Up (Ctrl+Option+Up on macOS). |
| **GLSL: Decrement Number at Cursor** | Nudge it down. Ctrl+Alt+Down (Ctrl+Option+Down on macOS). |
| **GLSL: Increment Number at Cursor (x10)** | Ctrl+Shift+Alt+Up (Ctrl+Shift+Option+Up on macOS). |
| **GLSL: Decrement Number at Cursor (x10)** | Ctrl+Shift+Alt+Down (Ctrl+Shift+Option+Down on macOS). |
| **GLSL: Show Shadertoy Preview** | Run the shader-toy extension's preview. Only shown when that extension is installed. |

The nudge keys only apply in GLSL editors; see
[Values panel](values-panel.md) for step sizes, the fallback when the cursor
is not on a number, and how to rebind them (Ctrl+K Ctrl+S, Cmd+K Cmd+S on
macOS).

## Other GLSL extensions

Several extensions contributing the `glsl` language is normal in VS Code, and
this one works next to them.

- If another installed extension also provides **diagnostics or completion**
  for GLSL (for example GLSL Lint, which also runs `glslangValidator`), you
  will see duplicate errors and suggestions. Disable that extension for the
  workspace, or turn off its validator.
- If another extension also provides **syntax highlighting**, only one
  grammar is used, depending on the order extensions are loaded. If the
  colors are not what you expect, disable the other extension for the
  workspace. The language server works with either grammar.
- **shader-toy** (stevensona) is complementary: it renders the preview, this
  extension does the editing. See
  [Shadertoy integration](#shadertoy-integration-optional).

## Remote and web

The extension runs where your files are: locally, or on the remote machine
in WSL, SSH and Dev Containers windows. In a remote window,
`glslangValidator` must be installed on the remote machine, and
`glslLsp.diagnostics.glslang.path` refers to a path there.

On Windows, Ctrl+Alt+Up/Down normally adds cursors. When the cursor is not on
a number, the nudge commands fall back to *Add Cursor Above/Below*. In a
remote window opened from Windows, this fallback may not apply; rebind the
nudge keys if you use Ctrl+Alt+Up/Down for multiple cursors.

The extension is desktop only: it is not available in vscode.dev or
github.dev. In a virtual workspace (a remote repository opened without a
clone) only syntax highlighting works.

### Restricted Mode

In an untrusted folder ([Restricted Mode](https://code.visualstudio.com/docs/editor/workspace-trust))
every feature keeps working. The only difference is
`glslLsp.diagnostics.glslang.path`: a value from the folder's
`.vscode/settings.json` is ignored, and a relative path in your user settings
is not resolved, so a repository you just cloned cannot choose a program for
the extension to run. Trust the folder to use its setting.
