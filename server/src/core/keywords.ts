// Language-level word sets the parser needs. Documentation for these words
// lives in server/src/builtins; this file is only about syntax.

export const BASIC_TYPES = new Set([
  'void', 'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4', 'dvec2', 'dvec3', 'dvec4', 'bvec2', 'bvec3', 'bvec4',
  'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4',
  'mat4x2', 'mat4x3', 'mat4x4',
  'dmat2', 'dmat3', 'dmat4', 'dmat2x2', 'dmat2x3', 'dmat2x4', 'dmat3x2', 'dmat3x3', 'dmat3x4',
  'dmat4x2', 'dmat4x3', 'dmat4x4',
  'atomic_uint',
  'sampler1D', 'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DRect', 'samplerBuffer',
  'sampler1DArray', 'sampler2DArray', 'samplerCubeArray', 'sampler2DMS', 'sampler2DMSArray',
  'sampler1DShadow', 'sampler2DShadow', 'samplerCubeShadow', 'sampler2DRectShadow',
  'sampler1DArrayShadow', 'sampler2DArrayShadow', 'samplerCubeArrayShadow', 'samplerExternalOES',
  'isampler1D', 'isampler2D', 'isampler3D', 'isamplerCube', 'isampler2DRect', 'isamplerBuffer',
  'isampler1DArray', 'isampler2DArray', 'isamplerCubeArray', 'isampler2DMS', 'isampler2DMSArray',
  'usampler1D', 'usampler2D', 'usampler3D', 'usamplerCube', 'usampler2DRect', 'usamplerBuffer',
  'usampler1DArray', 'usampler2DArray', 'usamplerCubeArray', 'usampler2DMS', 'usampler2DMSArray',
  'image1D', 'image2D', 'image3D', 'imageCube', 'image2DRect', 'imageBuffer', 'image1DArray',
  'image2DArray', 'imageCubeArray', 'image2DMS', 'image2DMSArray',
  'iimage1D', 'iimage2D', 'iimage3D', 'iimageCube', 'iimage2DArray', 'iimageBuffer',
  'uimage1D', 'uimage2D', 'uimage3D', 'uimageCube', 'uimage2DArray', 'uimageBuffer',
]);

/** Storage, interpolation, precision, memory and other declaration qualifiers. */
export const QUALIFIERS = new Set([
  'const', 'in', 'out', 'inout', 'uniform', 'buffer', 'shared', 'attribute', 'varying',
  'centroid', 'flat', 'smooth', 'noperspective', 'patch', 'sample',
  'highp', 'mediump', 'lowp', 'invariant', 'precise',
  'coherent', 'volatile', 'restrict', 'readonly', 'writeonly', 'subroutine',
]);

export const PRECISION_QUALIFIERS = new Set(['highp', 'mediump', 'lowp']);

export const CONTROL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'return', 'discard',
]);

export const OTHER_KEYWORDS = new Set(['struct', 'layout', 'precision', 'true', 'false']);

/**
 * Qualifiers that older GLSL versions (and real code such as LYGIA's
 * `centroid()` or a variable named `sample`) use as plain identifiers. The
 * parser accepts them as names when they are not in qualifier position.
 */
export const SOFT_KEYWORDS = new Set([
  'sample', 'centroid', 'patch', 'buffer', 'shared', 'subroutine', 'precise', 'coherent',
  'volatile', 'restrict', 'readonly', 'writeonly', 'noperspective', 'smooth', 'flat',
  'invariant', 'attribute', 'varying',
]);

/** True if `word` can be used as a user identifier (not a hard keyword). */
export function canBeIdentifier(word: string): boolean {
  return !isKeyword(word) || SOFT_KEYWORDS.has(word);
}

/** Every reserved word that can never be a user identifier. */
export function isKeyword(word: string): boolean {
  return BASIC_TYPES.has(word) || QUALIFIERS.has(word) || CONTROL_KEYWORDS.has(word) || OTHER_KEYWORDS.has(word);
}

/** Words reserved for future use by GLSL / GLSL ES: compile errors as names. */
export const RESERVED_WORDS = new Set([
  'asm', 'class', 'union', 'enum', 'typedef', 'template', 'this', 'packed', 'resource', 'goto',
  'inline', 'noinline', 'public', 'static', 'extern', 'external', 'interface', 'long', 'short',
  'half', 'fixed', 'unsigned', 'superp', 'input', 'output', 'hvec2', 'hvec3', 'hvec4', 'fvec2',
  'fvec3', 'fvec4', 'sampler3DRect', 'filter', 'sizeof', 'cast', 'namespace', 'using', 'common',
  'partition', 'active', 'image1DShadow', 'image2DShadow', 'image1DArrayShadow', 'image2DArrayShadow',
]);

/**
 * Why `name` cannot be a user identifier (keyword, reserved word, `gl_`
 * prefix, consecutive underscores), or undefined when it can.
 */
export function invalidIdentifierReason(name: string): string | undefined {
  if (!/^[A-Za-z_]\w*$/.test(name)) return `'${name}' is not a valid identifier`;
  if (isKeyword(name)) return `'${name}' is a GLSL keyword`;
  if (RESERVED_WORDS.has(name)) return `'${name}' is a reserved word in GLSL`;
  if (name.startsWith('gl_')) return `names starting with 'gl_' are reserved`;
  if (name.includes('__')) return `names containing '__' are reserved`;
  return undefined;
}

export const SWIZZLE_RE = /^([xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/;

export const GLSL_FILE_EXTENSIONS = ['.glsl', '.frag', '.vert', '.comp', '.geom', '.tesc', '.tese'];

export function isGlslPath(path: string): boolean {
  const lower = path.toLowerCase();
  return GLSL_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
