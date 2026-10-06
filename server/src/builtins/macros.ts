// Predefined preprocessor macros.

import type { BuiltinMacro } from './types';

export const builtinMacros: BuiltinMacro[] = [
  { kind: 'macro', name: '__LINE__', doc: 'The current source line number.' },
  { kind: 'macro', name: '__FILE__', doc: 'The current source string number (not a path).' },
  { kind: 'macro', name: '__VERSION__', doc: 'The GLSL version as an integer, e.g. `300` for `#version 300 es` or `330` for `#version 330`.' },
  { kind: 'macro', name: 'GL_ES', doc: 'Defined (to 1) when compiling GLSL ES (WebGL, mobile, Shadertoy).', value: '1' },
  { kind: 'macro', name: 'GL_FRAGMENT_PRECISION_HIGH', doc: 'Defined (to 1) in GLSL ES fragment shaders when `highp` float is supported.', value: '1' },
  { kind: 'macro', name: 'GL_core_profile', doc: 'Defined (to 1) when compiling with the core profile.', value: '1' },
  { kind: 'macro', name: 'GL_compatibility_profile', doc: 'Defined (to 1) when compiling with the compatibility profile.', value: '1' },
  { kind: 'macro', name: 'GL_SPIRV', doc: 'Defined when compiling for SPIR-V (Vulkan / OpenGL SPIR-V).' },
  { kind: 'macro', name: 'VULKAN', doc: 'Defined to the Vulkan GLSL semantics version when compiling for Vulkan.' },
];
