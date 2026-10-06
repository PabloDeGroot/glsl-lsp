# Diagnostics

How the extension finds problems in your shaders, what `glslangValidator` adds, and the known limitations.

[← Back to README](../README.md)

- [Two layers](#two-layers)
- [Fast checks](#fast-checks)
- [Compiler errors with glslangValidator](#compiler-errors-with-glslangvalidator)
- [Install glslangValidator](#install-glslangvalidator)
- [Known limitations](#known-limitations)
- [Settings](#settings)

## Two layers

| Layer | Needs | Runs on | Finds |
| --- | --- | --- | --- |
| **Fast checks** | Nothing, built in | Open, save and every edit (debounced) | Unresolved includes, include cycles, syntax errors, duplicate definitions, undeclared identifiers |
| **glslangValidator** | `glslangValidator` installed (optional) | Open, save and every edit (debounced) | Everything the reference compiler reports: type errors, wrong argument types, version and extension rules |

Both layers report into the Problems panel and as squiggles in the editor.
When `glslLsp.diagnostics.onType` is off, both wait until the file is opened
or saved.

![The Problems panel with two glslangValidator errors on one line](../images/diagnostics.png)

## Fast checks

These run in the language server itself, so they work without any setup:

- **Unresolved `#include`s** and **include cycles** (warning). An
  unresolved `#include "..."` is an error. An unresolved `#include <...>` is a
  warning, because angle brackets usually name a file your engine or framework
  supplies; with the [three.js preset](#threejs-and-other-runtimes-that-inject-code)
  it is not reported at all.
- **Syntax errors.**
- **Duplicate definitions** of the same function overload, struct or global,
  also against the files you include. Definitions inside any `#if`,
  `#ifdef` or `#ifndef` block (include guards too) are skipped, since they
  are often alternatives.
- **Undeclared identifiers.** If the name is declared in a workspace file the
  current shader does not include, it is an **error** with an *Add #include*
  quick fix. Any other unknown name is a **warning**.

![An undeclared snoise call with the "Add #include" quick fix](../images/quickfix.png)

Builtins (GLSL functions and `gl_*` variables, including Vulkan ones such as
`gl_VertexIndex`), the names you declare in
[`glslLsp.environment`](configuration.md#environment), and the Shadertoy
uniforms where [Shadertoy support](configuration.md#shadertoy-integration-optional)
applies are never reported as undeclared.

Quick fixes offered from the light bulb:

- *Add `#include "..."`* for an undeclared name that another file declares.
- *Change to `"..."`* for an `#include` that cannot be found, when a file with
  the same name exists elsewhere in the workspace.
- *Remove unused / redundant `#include`* on an include line that nothing uses,
  or that is already pulled in through another include.

## Compiler errors with glslangValidator

[glslangValidator](https://github.com/KhronosGroup/glslang) is the Khronos
reference compiler. When it is installed, the extension compiles your shaders
with it and shows its errors in place.

### Which files are compiled

Only complete shaders are compiled:

- a file that defines `main()` **and** has a `#version` line, or
- a file that defines `mainImage` where
  [Shadertoy support](configuration.md#shadertoy-integration-optional) applies.
  It is compiled inside a generated `main()` with the Shadertoy uniforms
  declared, so it needs no `#version` of its own.

Files without `#version` (for example three.js `ShaderMaterial` code or
WebGL 1 snippets) get the fast checks only.

**Library files** (no `main` or `mainImage`) are compiled as part of the open
shaders that include them. Their errors appear in the library file and as a
summary on the `#include` line of the shader.

### What gets passed to the compiler

- **Includes are inlined**, each file once, as include guards would. An error
  inside an included file is reported on that file, plus a summary on the
  `#include` line.
- **The stage comes from the file name**:

  | File name | Stage |
  | --- | --- |
  | `.vert`, `.vsh`, `.vshader`, `.glslv`, `.vs` | vertex |
  | `.frag`, `.fsh`, `.fshader`, `.glslf`, `.fs` | fragment |
  | `.comp`, `.cs` | compute |
  | `.geom`, `.gsh`, `.gshader`, `.glslg`, `.gs` | geometry |
  | `.tesc` | tessellation control |
  | `.tese` | tessellation evaluation |
  | `.mesh`, `.task`, `.rgen`, `.rchit`, `.rahit`, `.rmiss`, `.rint`, `.rcall` | mesh, task and ray tracing (Vulkan) |

  A double extension works too: `water.vert.glsl`, `water.vs.glsl`. Any other
  `.glsl` file is compiled as a **fragment** shader, so name vertex shaders
  `*.vert` or `*.vert.glsl`. (`.vs`, `.fs`, `.gs`, `.cs`, `.mesh`, `.task` and
  the ray tracing extensions are not opened as GLSL by default; see
  [File extensions](configuration.md#file-extensions).)
- **OpenGL or Vulkan rules.** A shader that uses Vulkan-only GLSL is compiled
  with Vulkan rules (`--target-env vulkan1.2`), anything else with OpenGL /
  OpenGL ES rules. Vulkan GLSL is recognized by `layout(set = ...)`,
  `push_constant`, `constant_id`, `input_attachment_index`, `subpassInput`,
  separate `texture2D` / `sampler` uniforms, `gl_VertexIndex` /
  `gl_InstanceIndex`, Vulkan-only extensions (`GL_KHR_vulkan_glsl`,
  `GL_EXT_ray_tracing`, `GL_EXT_buffer_reference`, ...) and the mesh, task and
  ray tracing stages, in the shader or any file it includes. To choose
  yourself, set `glslLsp.diagnostics.glslang.targetEnv` to `opengl` or to a
  Vulkan version (`vulkan1.0` to `vulkan1.3`).
- **Your environment** (`glslLsp.environment.uniforms` and `.defines`) is
  declared right after `#version`, or after the Shadertoy preamble. A uniform
  or define the shader declares itself is not declared twice. With Vulkan
  rules, plain uniforms go into one uniform block and samplers get their own
  bindings, all in descriptor set 7, because Vulkan GLSL requires that.
- **Shadertoy files** are wrapped in a WebGL2 preamble that mirrors the one the
  [shader-toy](https://marketplace.visualstudio.com/items?itemName=stevensona.shader-toy)
  extension uses: the Shadertoy uniforms, `iChannel0-3` with the types given
  by `#iChannel` directives, the `#iKeyboard` helpers and your `#iUniform`s.

### When glslangValidator is missing

`glslLsp.diagnostics.glslang.enable` is on by default. If glslangValidator is
not found, compiler checks stay off until a `glslLsp.diagnostics.glslang.*`
setting changes, and a notice says so once per session. Everything else keeps
working. The notice offers:

- **How to Install**: opens [Install glslangValidator](#install-glslangvalidator).
  After installing, run **GLSL: Restart Language Server** (or reload the
  window).
- **Turn Off Compiler Checks**: sets `glslLsp.diagnostics.glslang.enable` to
  `false` in your user settings.
- **Don't Show Again**: no more notices on this machine; the reason is still
  logged in **GLSL: Show Language Server Output**.

If you set `glslLsp.diagnostics.glslang.path` yourself and that path does not
work, a warning with an **Open Setting** button appears instead, every
session, since that is a configuration mistake.

A different warning appears once if the executable starts but exits with an
error code and no compiler messages (for example a broken wrapper script).
Compiler checks stay on in that case. A compile that
takes longer than 5 seconds is cancelled and logged in
**GLSL: Show Language Server Output**.

## Install glslangValidator

| Platform | Command |
| --- | --- |
| Arch Linux | `sudo pacman -S glslang` |
| Debian / Ubuntu | `sudo apt install glslang-tools` |
| Fedora | `sudo dnf install glslang` |
| macOS (Homebrew) | `brew install glslang` |
| Windows | The [Vulkan SDK](https://vulkan.lunarg.com/sdk/home) includes it. Or with MSYS2: `pacman -S mingw-w64-x86_64-glslang` |
| Any | Prebuilt binaries from the [glslang releases](https://github.com/KhronosGroup/glslang/releases) |

Check that it is on your `PATH`:

```sh
glslangValidator --version
```

If it is not on `PATH`, point the extension at it:

```jsonc
// settings.json
{
  "glslLsp.diagnostics.glslang.path": "C:/VulkanSDK/1.3.296.0/Bin/glslangValidator.exe"
}
```

A name without a folder (the default `glslangValidator`) is looked up on
`PATH` only, never in the workspace folder, so a repository cannot make the
extension run a program it ships. A relative path such as
`tools/glslangValidator` is resolved against the first workspace folder, and
only in a trusted workspace. In
[Restricted Mode](https://code.visualstudio.com/docs/editor/workspace-trust)
the extension keeps working, but only the value from your user settings is
used for this setting.

A `.cmd` or `.bat` wrapper works on Windows. In a Remote window (WSL, SSH,
Dev Containers), the language server runs on the remote machine, so install
glslangValidator there.

## Known limitations

### Vulkan GLSL

Vulkan shaders are compiled with Vulkan rules (see
[OpenGL or Vulkan rules](#what-gets-passed-to-the-compiler)). What is not
supported yet:

- **Ray tracing, mesh and task shaders.** The fast checks do not know their
  qualifiers and builtins (`rayPayloadInEXT`, `hitAttributeEXT`,
  `gl_LaunchIDEXT`, `SetMeshOutputsEXT`, ...), so they report false syntax
  errors and undeclared names. Their file extensions are not opened as GLSL
  by default for that reason. If you map them with `files.associations`,
  glslangValidator still compiles them for the right stage with Vulkan
  rules; set `glslLsp.diagnostics.undeclared` to `false` in that project to
  hide the false undeclared reports.
- **Detection is per shader.** A Vulkan shader that uses none of the
  constructs listed above (only `layout(binding = ...)` blocks, for example)
  is compiled with OpenGL rules. Set `glslLsp.diagnostics.glslang.targetEnv`
  to `vulkan1.2` (or your version) in the project's `.vscode/settings.json`
  to force Vulkan rules:

  ```jsonc
  {
    "glslLsp.diagnostics.glslang.targetEnv": "vulkan1.2"
  }
  ```

### three.js and other runtimes that inject code

three.js adds attributes, uniforms and shader chunks to a `ShaderMaterial`
before compiling it. Turn on the three.js preset so the extension knows them:

```jsonc
// .vscode/settings.json
{
  "glslLsp.environment.presets": ["three.js"]
}
```

With the preset, `modelMatrix`, `modelViewMatrix`, `projectionMatrix`,
`viewMatrix`, `normalMatrix`, `cameraPosition`, `isOrthographic` and the
`position`, `normal` and `uv` attributes behave like builtins (hover,
completion, no undeclared report), and chunk includes such as
`#include <common>` are not reported. Without it, those names are reported as
undeclared (warnings) and the chunk includes as unresolved (warnings).

In a file that includes a chunk, undeclared names are not reported at all,
since the chunks define names no file in your workspace declares
(`transformed`, `PI`, ...). Elsewhere the preset covers what three.js always
adds. Names it adds only for some materials (`color` with `vertexColors`,
`instanceMatrix` for instancing, skinning and morph attributes) are not
included: declare the ones you use in `glslLsp.environment.uniforms`, which
wins over the preset. three.js shaders usually have no `#version`, so they are not
compiled by glslangValidator. A `RawShaderMaterial` gets nothing injected
and needs no preset.

The same approach (declaring the names in `glslLsp.environment`) works for
any engine or tool that injects uniforms or defines; see
[Environment](configuration.md#environment).

### Other gaps

- A file without `#version` is never compiled (see
  [Which files are compiled](#which-files-are-compiled)).
- A `.glsl` file with no stage in its name is compiled as a fragment shader.
  A vertex shader saved as `foo.glsl` gets false errors such as
  `'gl_Position' : undeclared identifier`. Rename it to `foo.vert` or
  `foo.vert.glsl`.
- A library file is only compiled while a shader that includes it is open.
- At most 200 undeclared identifiers are reported per file. Names used
  inside `#if`/`#ifdef` blocks are not checked, and the check is skipped in
  files whose macros paste tokens with `##`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `glslLsp.diagnostics.enable` | `true` | Master switch for all diagnostics. |
| `glslLsp.diagnostics.undeclared` | `true` | Report undeclared identifiers. |
| `glslLsp.diagnostics.onType` | `true` | Re-run all diagnostics while typing (debounced). When off, files are checked when opened and saved. Changes on disk always re-check the open files that depend on them. |
| `glslLsp.diagnostics.glslang.enable` | `true` | Compile shaders with `glslangValidator` and report its errors. |
| `glslLsp.diagnostics.glslang.path` | `glslangValidator` | The executable. A bare name is looked up on `PATH`; a relative path is resolved against the first workspace folder. |
| `glslLsp.diagnostics.glslang.targetEnv` | `auto` | `auto` (Vulkan rules for Vulkan GLSL, else OpenGL), `opengl`, or `vulkan1.0` to `vulkan1.3`. |
| `glslLsp.environment.uniforms` / `.defines` | `[]` / `{}` | Names your runtime provides. See [Environment](configuration.md#environment). |
| `glslLsp.environment.presets` | `[]` | `["three.js"]`: the names three.js injects. See [three.js](#threejs-and-other-runtimes-that-inject-code). |
| `glslLsp.shadertoy.enable` | `auto` | Where Shadertoy support applies. See [Shadertoy integration](configuration.md#shadertoy-integration-optional). |

All settings: [Configuration](configuration.md).
