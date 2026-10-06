# Formatting

How the GLSL formatter works, what it changes and what it leaves alone.

[← Back to README](../README.md)

The formatter provides **Format Document**, **Format Selection** and format
on type. Format on type runs after `}`, `;` and Enter (with
`editor.formatOnType` on) and re-indents only the current line.

The default mode is deliberately gentle, so it can run on save over
hand-tuned shader code. Hand-aligned columns, `float a    = 1.0;` padding and
aligned trailing comments stay exactly as they are.

![Format Document in opinionated mode: a cramped fragment shader on the left, the same shader with consistent indentation and spacing on the right](../images/format.png)

## Format on save

Add this to your user or workspace `settings.json`:

```jsonc
"[glsl]": {
  "editor.defaultFormatter": "pablodegroot.glsl-lsp",
  "editor.formatOnSave": true,
  "editor.formatOnType": true
}
```

`editor.defaultFormatter` matters when another installed extension also
formats GLSL (a clang-format extension, for example); without it VS Code asks
which one to use.

## Modes

| `glslLsp.format.mode` | Changes |
| --- | --- |
| `conservative` (default) | Indentation by brace and parenthesis depth, trailing whitespace, runs of blank lines (`maxBlankLines`), the final newline, a missing space after `,` and `;` (not inside `for (;;)` or before `}`), and missing spaces around `=`, `+=` and the other assignments. Nothing else. |
| `opinionated` | Everything above, plus the rules listed below. |
| `off` | Format requests return no edits. Use this to keep another formatter. |

Opinionated mode adds:

- spaces around binary operators (not unary `-x`, `1e-3` or `++`/`--`: `a++ + b`);
- one space after `if` / `for` / `while` / `switch` / `return`;
- no space before a call's `(`, inside `( )` / `[ ]`, or before `,` / `;`;
- one space before `{`, and one-line blocks padded (`{ x(); }`);
- un-braced bodies indented one level;
- brace placement per `glslLsp.format.braceStyle`.

Example (opinionated):

```glsl
// before
float f(float x){
return x*x+-1.0*sin (x) ;
}
// after
float f(float x) {
    return x * x + -1.0 * sin(x);
}
```

## Indentation

These rules apply in both modes.

- Continuation lines of a multi-line expression or argument list get at least
  one extra level. Deeper hand alignment is kept and moves with the
  statement:

  ```glsl
  vec3 c = mix(a,          // stays aligned under `a`
               b, t);
  ```

- Bodies of `if` / `for` / `while` / `else` / `do` without braces: opinionated
  mode indents them one level. Conservative mode keeps them at least at the
  header's level, so stacked loops over one body stay flat.
- A trailing comment aligned with the one on the line above or below keeps its
  column even when its line is re-indented (when the code leaves room).
  Comment-only lines continuing an aligned trailing comment keep its column.
- In conservative mode, comment lines indented deeper than the code (such as
  commented-out code) keep their extra indentation.
- Lines inside a `/* ... */` block move with the comment's first line, but
  only when every one of them starts with that line's indentation.
- `#if` / `#elif` / `#else` branches each start from the depth at `#if`, and
  `#endif` continues from the end of the first branch. So branches that each
  open a brace (common in LYGIA) keep the depth right. A lone branch (no
  `#else`) that changes the depth is undone at `#endif`.
- `#if 0` / `#if false` branches are not code: they are left exactly as they
  are and do not count for the depth.
- A file whose braces or parentheses do not balance keeps its indentation. The
  other rules still apply.

## What is never touched

- Preprocessor lines, apart from trailing whitespace: LYGIA include guards,
  `#define`s, shader-toy `#iUniform` / `#iChannel` directives. Set
  `glslLsp.format.indentPreprocessor` to indent them to the brace depth.
- Lines continued with `\`: every line of the group. A `//` comment ending in
  `\` continues onto the next line, so that line is left alone too.
- The text of comments.
- Everything between `// glsl-format off` and `// glsl-format on`:

```glsl
// glsl-format off
const mat3 M = mat3( 0.00,  0.80,  0.60,
                    -0.80,  0.36, -0.48,
                    -0.60, -0.48,  0.64);
// glsl-format on
```

## Guarantees

- The editor's tab size and spaces/tabs choice are used.
- Trailing whitespace is removed, extra blank lines at the end of the file
  are trimmed and a final newline is added. These follow the LSP formatting
  options `trimTrailingWhitespace`, `insertFinalNewline` and
  `trimFinalNewlines`, and are skipped only when the editor sends them as
  `false`. VS Code never does, so in VS Code they always apply, whatever the
  `files.*` settings say.
- Lines are never wrapped or joined, apart from brace placement in opinionated
  mode.
- Every edit is minimal: only the changed characters are replaced, so cursors
  and undo behave.
- Formatting never changes the code's tokens. A result that would is
  discarded.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `glslLsp.format.mode` | `conservative` | `conservative`, `opinionated` or `off` (see [Modes](#modes)). |
| `glslLsp.format.maxBlankLines` | `1` | Longest run of consecutive blank lines kept. |
| `glslLsp.format.braceStyle` | `preserve` | Opinionated mode only: `preserve`, `sameLine` (`void f() {`, `} else {`) or `nextLine` (`{` on its own line, `else` on the line after `}`). Initializer lists and one-line blocks never move, and a brace never moves across a comment, a preprocessor line or a blank line. |
| `glslLsp.format.indentPreprocessor` | `false` | Indent preprocessor lines (`#ifdef`, `#define`, ...) to the brace depth of the surrounding code. When off, they keep their indentation. |

The other settings are in [Configuration](configuration.md).
