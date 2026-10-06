// GLSL keywords, storage / interpolation / precision / memory qualifiers and
// control flow, with docs and optional completion snippets.

import type { BuiltinKeyword } from './types';

type Cat = BuiltinKeyword['category'];
const k = (name: string, category: Cat, doc: string, snippet?: string): BuiltinKeyword => ({ kind: 'keyword', name, category, doc, ...(snippet ? { snippet } : {}) });
const q = (name: string, doc: string) => k(name, 'qualifier', doc);

export const builtinKeywords: BuiltinKeyword[] = [
  // ---- storage qualifiers
  q('const', 'Compile-time constant, or a read-only function parameter (`const in`).'),
  q('in', 'Input: a stage input variable, or a function parameter copied into the function (the default).'),
  q('out', 'Output: a stage output variable, or a function parameter copied out of the function on return. The initial value is undefined.'),
  q('inout', 'Function parameter copied into the function and back out on return.'),
  q('uniform', 'Value is constant across a draw call and set by the application (in Shadertoy, by the host).'),
  q('buffer', 'Declares a shader storage block: read/write memory shared with the application.'),
  q('shared', 'Variable shared by all invocations of a compute work group.'),
  q('attribute', 'GLSL ES 1.00 vertex shader input. Use `in` in newer versions.'),
  q('varying', 'GLSL ES 1.00 interpolated vertex-to-fragment value. Use `out` / `in` in newer versions.'),
  q('patch', 'Marks a tessellation input or output as per-patch rather than per-vertex.'),
  q('subroutine', 'Declares a subroutine type or function, selectable from the application at runtime.'),

  // ---- interpolation
  q('smooth', 'Perspective-correct interpolation of a fragment input (the default).'),
  q('flat', 'No interpolation: the fragment input takes the value of the provoking vertex. Required for integer varyings.'),
  q('noperspective', 'Linear interpolation in screen space, without perspective correction.'),
  q('centroid', 'Interpolate at a point inside the primitive even when the pixel centre is outside it (multisampling).'),
  q('sample', 'Interpolate per sample rather than per pixel, forcing per-sample shading.'),

  // ---- precision
  q('highp', 'Highest precision qualifier: full 32-bit float on mobile GPUs. The only precision that exists on desktop GLSL.'),
  q('mediump', 'Medium precision qualifier (at least 16-bit float). A hint on mobile GPUs, a no-op on desktop.'),
  q('lowp', 'Low precision qualifier (at least 10-bit fixed point). A hint on mobile GPUs, a no-op on desktop.'),

  // ---- invariance, memory
  q('invariant', 'Guarantees the output is computed identically across shaders when the same expressions and inputs are used (avoids z-fighting between passes).'),
  q('precise', 'Forbids optimizations that change the result of an expression (such as fused multiply-add).'),
  q('coherent', 'Memory qualifier: writes are made visible to other invocations that also use `coherent` access.'),
  q('volatile', 'Memory qualifier: the value may change at any time through another invocation; never cache it.'),
  q('restrict', 'Memory qualifier: no other variable aliases this memory.'),
  q('readonly', 'Memory qualifier: the buffer or image can only be read.'),
  q('writeonly', 'Memory qualifier: the buffer or image can only be written.'),

  // ---- declarations
  k('struct', 'other', 'Declares an aggregate type of named fields.', 'struct ${1:Name} {\n\t$0\n};'),
  k('layout', 'qualifier', 'Specifies storage details of a declaration: `layout(location = 0) out vec4 color;`.', 'layout(${1:location} = ${2:0}) '),
  k('precision', 'other', 'Sets the default precision for a type: `precision highp float;`.', 'precision ${1|highp,mediump,lowp|} ${2:float};'),
  k('true', 'other', 'Boolean literal true.'),
  k('false', 'other', 'Boolean literal false.'),

  // ---- control flow
  k('if', 'control', 'Conditional statement.', 'if (${1:condition}) {\n\t$0\n}'),
  k('else', 'control', 'Alternative branch of an `if`.', 'else {\n\t$0\n}'),
  k('for', 'control', 'Loop statement. Bounds should be constant expressions in GLSL ES 1.00.', 'for (int ${1:i} = 0; ${1:i} < ${2:count}; ${1:i}++) {\n\t$0\n}'),
  k('while', 'control', 'Loop while a condition holds.', 'while (${1:condition}) {\n\t$0\n}'),
  k('do', 'control', 'Loop whose body runs once before the `while` condition is tested.', 'do {\n\t$0\n} while (${1:condition});'),
  k('switch', 'control', 'Multi-way branch on an integer expression (GLSL 1.30+, ES 3.0+).', 'switch (${1:value}) {\n\tcase ${2:0}:\n\t\t$0\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}'),
  k('case', 'control', 'A label within a `switch`.'),
  k('default', 'control', 'The fallback label within a `switch`.'),
  k('break', 'control', 'Exit the innermost loop or `switch`.'),
  k('continue', 'control', 'Skip to the next iteration of the innermost loop.'),
  k('return', 'control', 'Return from the current function, optionally with a value.'),
  k('discard', 'control', 'Fragment shaders only: abandon the fragment, writing nothing to the framebuffer.'),
];
