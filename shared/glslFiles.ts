// File extensions the extension claims as GLSL. One list for the language
// server's indexer (server/src/core/keywords.ts), the client's file watcher
// (client/src/extension.ts), package.json contributes.languages and the
// grammar's fileTypes (test/fileExtensions.test.ts keeps those two in sync).
//
// Not claimed, because other languages or binary assets use them: .fs (F#),
// .vs, .gs (Google Apps Script), .cs (C#), .shader (Unity ShaderLab), .mesh and
// .task (mesh files). Users map them with `files.associations`; the shader
// stage is still taken from the extension (features/diagnostics/flatten.ts).
// The Vulkan ray tracing stages (.rgen, .rchit, ...) are not claimed yet: the
// builtins have no ray tracing qualifiers, variables or functions.
//
// PURE like valuesProtocol.ts: no imports, so every tsconfig can include it.

export const GLSL_FILE_EXTENSIONS = [
  '.glsl',
  '.frag',
  '.vert',
  '.comp',
  '.geom',
  '.tesc',
  '.tese',
  '.vsh',
  '.fsh',
  '.gsh',
  '.vshader',
  '.fshader',
  '.gshader',
  '.glslv',
  '.glslf',
  '.glslg',
];

/** `**\/*.{glsl,frag,...}` for file watchers. */
export const GLSL_FILE_GLOB = `**/*.{${GLSL_FILE_EXTENSIONS.map((e) => e.slice(1)).join(',')}}`;
