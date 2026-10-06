# Contributing

Bug reports, shader snippets that confuse the parser, and pull requests are
welcome. Please open an issue at
[github.com/PabloDeGroot/glsl-lsp/issues](https://github.com/PabloDeGroot/glsl-lsp/issues)
with the smallest GLSL file that shows the problem, the setting values you
changed, and the output of the **GLSL Language Server** output channel if
anything was logged there.

## Build

The extension is plain TypeScript bundled with esbuild. There is no native
code, so the same setup works on Windows, macOS and Linux.

```sh
npm install
npm run build        # development build into dist/
npm run watch        # rebuild dist/ on change
npm run typecheck    # tsc for the extension, the server and the webview
```

## Test

```sh
npm test             # unit tests + real-workspace tests (vitest)
npm run test:watch   # vitest in watch mode
npm run test:e2e     # only the end-to-end test
```

The end-to-end test builds the extension, spawns `dist/server.js` over stdio
and talks LSP to it, with a real shader workspace as its folder (see below);
without one it is skipped. Set `GLSL_LSP_E2E_NO_BUILD=1` to test the `dist/`
that is already there (for example the minified build from
`npm run package`).

### Real-workspace tests

Some tests run against a real shader workspace, for example a folder with
LYGIA next to your shaders. They use:

1. the folder in `GLSL_LSP_E2E_ROOT`, when it is set (an error if that folder
   does not exist, so a typo does not silently skip everything);
2. otherwise the folder that contains this repository.

Either is used only when it looks like a shader workspace: a `lygia/` folder,
or `.glsl` files at the top or one folder down. Otherwise those tests are
skipped. They only read the workspace and never modify it.

```sh
GLSL_LSP_E2E_ROOT=~/shaders npm test
```

`test/fixtures/` holds a `.glsl-lsp-ignore` marker, so when this repository is
cloned inside a shader workspace its fixtures do not show up as completion
candidates there.

### Known test failures

On Linux (and, by the same path logic, macOS), `npm test` currently reports
3 failures:

- two tests in `test/autoInclude.test.ts` (*Windows drive letter URIs*), which
  build their workspace from Windows paths such as `C:\Users\dev\shaders`;
- one test in `test/fixtures.test.ts` (*accepts differently spelled URIs*),
  whose alternate spelling becomes `file:////home/...` on POSIX, which is not
  a valid URI.

Both come from how the tests build their paths, not from the server. The
expected result on those platforms is 3 failed and the rest passed; how many
are skipped depends on whether a real workspace was found. A fix (run the Windows tests only on Windows, build the alternate
URI in a platform-neutral way) is welcome.

## Debug

Open this folder in VS Code and press F5 (**Run Extension**). It builds the
extension and starts an Extension Development Host on `test/fixtures/project`.

Use the **Extension + Server** compound configuration to also attach a
debugger to the language server (port 6009). In the Extension Development
Host the server runs with `--inspect=6009`, so breakpoints in `server/src/`
work.

### Values panel harness

The Values panel UI can be checked in a browser without VS Code. Run
`npm run build`, then open `webview/dev/harness.html` with URL parameters:

| Parameter | Values |
| --- | --- |
| `theme` | `dark`, `light`, `hc` |
| `scene` | `color`, `float`, `vec2`, `vector`, `vec4`, `palette`, `paletteNoC`, `multi`, `stale`, `empty`, `noEditor`, `hdr`, `locked`, `childColor`, `cursorFloat`, `many`, `crossfile`, `longlabel` |
| `w` | panel width in pixels, for example `320` |
| `h` | panel height in pixels |
| `selftest` | `1` runs a scripted check of the messages the panel sends |

Example: `webview/dev/harness.html?theme=light&scene=palette&w=320`.

The harness fakes the VS Code API and is not shipped in the extension.

## Where things are

- [ARCHITECTURE.md](ARCHITECTURE.md): the module map, the data model and a
  step-by-step guide to adding a feature.
- [docs/VALUES.md](docs/VALUES.md): the specification of the Values panel
  (layout, widgets, keyboard map, edits and undo, pins, detection).
- The user documentation is in [README.md](README.md) and [docs/](docs).

The server has a **core** (`server/src/core/`) that knows GLSL and nothing
about VS Code, and one file per LSP feature in `server/src/features/`. New
GLSL knowledge goes in the core with unit tests; features only translate core
results into LSP responses.

## Package

```sh
npm run package      # minified build, writes glsl-lsp-<version>.vsix
code --install-extension glsl-lsp-<version>.vsix
```

`npm run package` runs `vsce package --no-dependencies`: everything the
extension needs is bundled into `dist/`, so `node_modules` is not shipped.
What goes into the `.vsix` is controlled by `.vscodeignore` (an allow list).
Images used by the README are not packaged; the Marketplace loads them from
GitHub, so push them before publishing.

Before a release:

1. `npm run typecheck && npm test` (see the known failures above).
2. Update `CHANGELOG.md` and the version in `package.json`.
3. `npm run package`, install the `.vsix` in a clean profile and try it.
4. Commit and push `images/` to `main` before publishing, so the README
   images load (see [images/SHOTLIST.md](images/SHOTLIST.md)).
