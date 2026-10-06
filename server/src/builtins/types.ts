// Data types for builtin GLSL knowledge: functions, variables, types,
// keywords and the Shadertoy / shader-toy extension environment.
//
// Conventions for data files:
//  - `type` strings are written as in the GLSL spec, generic families
//    included: genType, genIType, genUType, genBType, genDType, vec, mat,
//    gsampler2D... Signature help and hover print them verbatim.
//  - `doc` is Markdown. Keep the first sentence a standalone summary: it is
//    used as the one-line completion detail.
//  - `minVersion` is the GLSL version number (110, 130, 300 for ES 3.0
//    style, 330, 400...). Omit when available everywhere that matters.

export type ShaderStage = 'vertex' | 'fragment' | 'compute' | 'geometry' | 'tessControl' | 'tessEval';

export interface BuiltinParam {
  name: string;
  type: string;
  /** `in` (default), `out` or `inout`. */
  qualifier?: 'in' | 'out' | 'inout';
  doc?: string;
}

export interface BuiltinOverload {
  returnType: string;
  params: BuiltinParam[];
  /** Overload-specific note (rendered under the general doc). */
  doc?: string;
  minVersion?: number;
}

export interface BuiltinFunction {
  kind: 'function';
  name: string;
  overloads: BuiltinOverload[];
  doc: string;
  /** e.g. 'math', 'texture', 'geometric', 'derivative', 'shadertoy'. */
  category?: string;
  minVersion?: number;
  stages?: ShaderStage[];
  /** Reference page, e.g. https://registry.khronos.org/OpenGL-Refpages/gl4/html/mix.xhtml */
  docUrl?: string;
  /** Only available in the Shadertoy environment (hidden when glslLsp.shadertoy.enable is false). */
  shadertoy?: boolean;
  /** Only available when the file declares this shader-toy directive (e.g. 'iKeyboard'). */
  requiresDirective?: 'iKeyboard';
  deprecated?: string;
  /** Optional completion snippet (LSP snippet syntax), e.g. for entry points. */
  snippet?: string;
}

export interface BuiltinVariable {
  kind: 'variable';
  name: string;
  type: string;
  doc: string;
  /** `in`, `out`, `uniform`, `const`... */
  qualifiers?: string[];
  stages?: ShaderStage[];
  minVersion?: number;
  docUrl?: string;
  shadertoy?: boolean;
  requiresDirective?: 'iKeyboard';
  /** For constants: the value, e.g. `65` for Key_A. */
  value?: string;
  deprecated?: string;
}

export interface BuiltinType {
  kind: 'type';
  name: string;
  doc: string;
  minVersion?: number;
  /** For vectors/matrices: component type and count (helps swizzle completion). */
  componentType?: string;
  components?: number;
  /** Only available in the shader-toy extension environment (e.g. color3). */
  shadertoy?: boolean;
}

export interface BuiltinKeyword {
  kind: 'keyword';
  name: string;
  doc: string;
  /** 'qualifier' | 'control' | 'preprocessor' | 'other' */
  category: 'qualifier' | 'control' | 'preprocessor' | 'other';
  /** Optional completion snippet (LSP snippet syntax). */
  snippet?: string;
}

/** Preprocessor / shader-toy directives offered after `#`. */
export interface BuiltinDirective {
  kind: 'directive';
  /** Without '#': 'include', 'iChannel0', 'iUniform'... */
  name: string;
  doc: string;
  snippet?: string;
  shadertoy?: boolean;
}

/** Predefined macros such as __VERSION__ or GL_ES. */
export interface BuiltinMacro {
  kind: 'macro';
  name: string;
  doc: string;
  value?: string;
}

export type BuiltinEntry = BuiltinFunction | BuiltinVariable | BuiltinType | BuiltinKeyword | BuiltinDirective | BuiltinMacro;

export interface BuiltinData {
  functions: BuiltinFunction[];
  variables: BuiltinVariable[];
  types: BuiltinType[];
  keywords: BuiltinKeyword[];
  directives: BuiltinDirective[];
  macros: BuiltinMacro[];
  /** Identifiers valid inside `layout(...)`: location, binding, local_size_x... */
  layoutQualifiers?: BuiltinKeyword[];
}
