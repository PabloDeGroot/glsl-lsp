// Preprocessor and shader-toy directives offered after '#'.

import type { BuiltinDirective } from './types';

const d = (name: string, doc: string, snippet?: string, shadertoy = false): BuiltinDirective => ({
  kind: 'directive',
  name,
  doc,
  ...(snippet ? { snippet } : {}),
  ...(shadertoy ? { shadertoy: true } : {}),
});

const channel = (n: number) =>
  d(
    `iChannel${n}`,
    `shader-toy extension: bind a texture, buffer or cubemap to \`iChannel${n}\`. Accepts \`"file://path"\` (image, or another .glsl file as a buffer pass), \`"https://..."\`, \`"self"\` (this buffer's previous frame), \`"keyboard"\` or \`"cubemap://..."\`.`,
    `iChannel${n} "\${1:file://}"`,
    true,
  );

export const builtinDirectives: BuiltinDirective[] = [
  d('include', 'Insert another file. Paths are relative to the including file (shader-toy extension and many engines resolve them recursively).', 'include "${1}"'),
  d('define', 'Define a macro: `#define NAME value` or function-like `#define NAME(a, b) expr`.', 'define ${1:NAME} ${2:value}'),
  d('undef', 'Remove a macro definition.', 'undef ${1:NAME}'),
  d('if', 'Conditional compilation: include the following block if the constant expression is non-zero.', 'if ${1:condition}\n\t$0\n#endif'),
  d('ifdef', 'Conditional compilation: include the following block if the macro is defined.', 'ifdef ${1:NAME}\n\t$0\n#endif'),
  d('ifndef', 'Conditional compilation: include the following block if the macro is not defined. Used for include guards.', 'ifndef ${1:NAME}\n#define ${1:NAME}\n$0\n#endif'),
  d('elif', 'Else-if branch of a conditional block.', 'elif ${1:condition}'),
  d('else', 'Else branch of a conditional block.'),
  d('endif', 'End a conditional block.'),
  d('error', 'Make compilation fail with the given message.', 'error ${1:message}'),
  d('pragma', 'Implementation-specific hints such as `#pragma optimize(off)` or `#pragma STDGL invariant(all)`.', 'pragma ${1}'),
  d('extension', 'Control a GLSL extension: `#extension GL_OES_standard_derivatives : enable`.', 'extension ${1:GL_EXT_name} : ${2|enable,require,warn,disable|}'),
  d('version', 'Declare the GLSL version, e.g. `#version 300 es` or `#version 330 core`. Must be the first line of a shader.', 'version ${1:300 es}'),
  d('line', 'Set the line number (and optionally source string number) reported in diagnostics.', 'line ${1:1}'),
  channel(0),
  channel(1),
  channel(2),
  channel(3),
  d(
    'iUniform',
    'shader-toy extension: declare a uniform with a UI control. Forms: `#iUniform float u_speed = 1.0 in { 0.0, 4.0 }` (slider), `#iUniform color3 u_tint = color3(1.0, 0.5, 0.2)` (colour picker), also `int`, `vec2`, `vec3`, `vec4` and `bool`.',
    'iUniform ${1|float,int,vec2,vec3,vec4,color3|} ${2:u_name} = ${3:1.0} in { ${4:0.0}, ${5:1.0} }',
    true,
  ),
  d('iKeyboard', 'shader-toy extension: enable keyboard input. Provides `isKeyDown`, `isKeyPressed`, `isKeyToggled`, `isKeyReleased` and the `Key_*` constants.', undefined, true),
];
