// Builtin functions, part 2: more common functions, geometric, matrix,
// vector relational, integer, packing and legacy noise.

import { fn } from './define';
import type { BuiltinFunction } from './types';

const NOISE_DEPRECATED = 'Removed from GLSL ES and unimplemented on most drivers.';

export const mathFunctions2: BuiltinFunction[] = [
  fn('mix', 'common', 'Linearly interpolate between `x` and `y`: `x * (1 - a) + y * a`. With a boolean `a`, selects `y` where true and `x` where false.', [
    'genType mix(genType x, genType y, genType a)',
    'genType mix(genType x, genType y, float a)',
    '@130 genType mix(genType x, genType y, genBType a)',
    '@400 genDType mix(genDType x, genDType y, genDType a)',
    '@400 genDType mix(genDType x, genDType y, double a)',
    '@130 genIType mix(genIType x, genIType y, genBType a)',
    '@130 genUType mix(genUType x, genUType y, genBType a)',
    '@130 genBType mix(genBType x, genBType y, genBType a)',
  ]),
  fn('step', 'common', 'Step function: `0.0` if `x < edge`, otherwise `1.0`.', [
    'genType step(genType edge, genType x)',
    'genType step(float edge, genType x)',
    '@400 genDType step(genDType edge, genDType x)',
    '@400 genDType step(double edge, genDType x)',
  ]),
  fn('smoothstep', 'common', 'Smooth Hermite interpolation between 0 and 1 when `edge0 < x < edge1`: `t*t*(3 - 2*t)` with `t = clamp((x - edge0) / (edge1 - edge0), 0, 1)`. Undefined if `edge0 >= edge1`.', [
    'genType smoothstep(genType edge0, genType edge1, genType x)',
    'genType smoothstep(float edge0, float edge1, genType x)',
    '@400 genDType smoothstep(genDType edge0, genDType edge1, genDType x)',
    '@400 genDType smoothstep(double edge0, double edge1, genDType x)',
  ]),
  fn('isnan', 'common', 'True where `x` is NaN.', ['genBType isnan(genType x)', '@400 genBType isnan(genDType x)'], { minVersion: 130 }),
  fn('isinf', 'common', 'True where `x` is positive or negative infinity.', ['genBType isinf(genType x)', '@400 genBType isinf(genDType x)'], { minVersion: 130 }),
  fn('floatBitsToInt', 'common', 'Reinterpret the bits of a float as a signed integer. No conversion is performed.', ['genIType floatBitsToInt(genType value)'], { minVersion: 330 }),
  fn('floatBitsToUint', 'common', 'Reinterpret the bits of a float as an unsigned integer. No conversion is performed.', ['genUType floatBitsToUint(genType value)'], { minVersion: 330 }),
  fn('intBitsToFloat', 'common', 'Reinterpret the bits of a signed integer as a float. No conversion is performed.', ['genType intBitsToFloat(genIType value)'], { minVersion: 330 }),
  fn('uintBitsToFloat', 'common', 'Reinterpret the bits of an unsigned integer as a float. No conversion is performed.', ['genType uintBitsToFloat(genUType value)'], { minVersion: 330 }),
  fn('fma', 'common', 'Fused multiply-add: `a * b + c`, computed with a single rounding.', ['genType fma(genType a, genType b, genType c)', 'genDType fma(genDType a, genDType b, genDType c)'], { minVersion: 400 }),
  fn('frexp', 'common', 'Split `x` into a significand in `[0.5, 1.0)` and an integer exponent, so that `x = significand * 2^exp`.', [
    'genType frexp(genType x, out genIType exp)',
    'genDType frexp(genDType x, out genIType exp)',
  ], { minVersion: 400 }),
  fn('ldexp', 'common', 'Build a float from a significand and an exponent: `x * 2^exp`.', [
    'genType ldexp(genType x, genIType exp)',
    'genDType ldexp(genDType x, genIType exp)',
  ], { minVersion: 400 }),

  // ---- geometric
  fn('length', 'geometric', 'Length (magnitude) of a vector: `sqrt(dot(x, x))`.', ['float length(genType x)', '@400 double length(genDType x)']),
  fn('distance', 'geometric', 'Distance between two points: `length(p0 - p1)`.', ['float distance(genType p0, genType p1)', '@400 double distance(genDType p0, genDType p1)']),
  fn('dot', 'geometric', 'Dot product of two vectors.', ['float dot(genType x, genType y)', '@400 double dot(genDType x, genDType y)']),
  fn('cross', 'geometric', 'Cross product of two 3-component vectors.', ['vec3 cross(vec3 x, vec3 y)', '@400 dvec3 cross(dvec3 x, dvec3 y)']),
  fn('normalize', 'geometric', 'Scale a vector to unit length: `x / length(x)`.', ['genType normalize(genType x)', '@400 genDType normalize(genDType x)']),
  fn('ftransform', 'geometric', 'Vertex transform identical to the fixed-function pipeline, for compatibility vertex shaders.', ['vec4 ftransform()'], { stages: ['vertex'], deprecated: 'Compatibility profile only.', docPage: false }),
  fn('faceforward', 'geometric', 'Orient a vector: returns `N` if `dot(Nref, I) < 0`, otherwise `-N`.', [
    'genType faceforward(genType N, genType I, genType Nref)',
    '@400 genDType faceforward(genDType N, genDType I, genDType Nref)',
  ]),
  fn('reflect', 'geometric', 'Reflection direction for incident vector `I` and surface normal `N` (which must be normalized): `I - 2 * dot(N, I) * N`.', [
    'genType reflect(genType I, genType N)',
    '@400 genDType reflect(genDType I, genDType N)',
  ]),
  fn('refract', 'geometric', 'Refraction direction for incident vector `I`, surface normal `N` and ratio of indices of refraction `eta`. `I` and `N` must be normalized. Returns zero on total internal reflection.', [
    'genType refract(genType I, genType N, float eta)',
    '@400 genDType refract(genDType I, genDType N, float eta)',
  ]),

  // ---- matrix
  fn('matrixCompMult', 'matrix', 'Component-wise multiplication of two matrices (not the linear-algebra product, which is `*`).', ['mat matrixCompMult(mat x, mat y)', '@400 dmat matrixCompMult(dmat x, dmat y)']),
  fn('outerProduct', 'matrix', 'Outer (linear algebra) product of column vector `c` and row vector `r`: a matrix whose element `[j][i]` is `c[i] * r[j]`.', [
    '@120 mat outerProduct(vec c, vec r)',
    '@400 dmat outerProduct(dvec c, dvec r)',
  ]),
  fn('transpose', 'matrix', 'Transpose of a matrix.', ['@120 mat transpose(mat m)', '@400 dmat transpose(dmat m)']),
  fn('determinant', 'matrix', 'Determinant of a square matrix.', ['@150 float determinant(mat m)', '@400 double determinant(dmat m)']),
  fn('inverse', 'matrix', 'Inverse of a square matrix. The result is undefined if the matrix is singular or poorly conditioned.', ['@140 mat inverse(mat m)', '@400 dmat inverse(dmat m)']),

  // ---- vector relational
  fn('lessThan', 'relational', 'Component-wise `x < y`.', ['bvec lessThan(vec x, vec y)', 'bvec lessThan(ivec x, ivec y)', 'bvec lessThan(uvec x, uvec y)']),
  fn('lessThanEqual', 'relational', 'Component-wise `x <= y`.', ['bvec lessThanEqual(vec x, vec y)', 'bvec lessThanEqual(ivec x, ivec y)', 'bvec lessThanEqual(uvec x, uvec y)']),
  fn('greaterThan', 'relational', 'Component-wise `x > y`.', ['bvec greaterThan(vec x, vec y)', 'bvec greaterThan(ivec x, ivec y)', 'bvec greaterThan(uvec x, uvec y)']),
  fn('greaterThanEqual', 'relational', 'Component-wise `x >= y`.', ['bvec greaterThanEqual(vec x, vec y)', 'bvec greaterThanEqual(ivec x, ivec y)', 'bvec greaterThanEqual(uvec x, uvec y)']),
  fn('equal', 'relational', 'Component-wise `x == y`.', ['bvec equal(vec x, vec y)', 'bvec equal(ivec x, ivec y)', 'bvec equal(uvec x, uvec y)', 'bvec equal(bvec x, bvec y)']),
  fn('notEqual', 'relational', 'Component-wise `x != y`.', ['bvec notEqual(vec x, vec y)', 'bvec notEqual(ivec x, ivec y)', 'bvec notEqual(uvec x, uvec y)', 'bvec notEqual(bvec x, bvec y)']),
  fn('any', 'relational', 'True if any component of the boolean vector is true.', ['bool any(bvec x)']),
  fn('all', 'relational', 'True if all components of the boolean vector are true.', ['bool all(bvec x)']),
  fn('not', 'relational', 'Component-wise logical complement.', ['bvec not(bvec x)']),

  // ---- integer
  fn('uaddCarry', 'integer', 'Add unsigned integers, returning the 32-bit sum and writing the carry (0 or 1) to `carry`.', ['genUType uaddCarry(genUType x, genUType y, out genUType carry)'], { minVersion: 400 }),
  fn('usubBorrow', 'integer', 'Subtract unsigned integers, returning the difference and writing the borrow (0 or 1) to `borrow`.', ['genUType usubBorrow(genUType x, genUType y, out genUType borrow)'], { minVersion: 400 }),
  fn('umulExtended', 'integer', 'Multiply unsigned 32-bit integers into a 64-bit result: high bits to `msb`, low bits to `lsb`.', ['void umulExtended(genUType x, genUType y, out genUType msb, out genUType lsb)'], { minVersion: 400 }),
  fn('imulExtended', 'integer', 'Multiply signed 32-bit integers into a 64-bit result: high bits to `msb`, low bits to `lsb`.', ['void imulExtended(genIType x, genIType y, out genIType msb, out genIType lsb)'], { minVersion: 400 }),
  fn('bitfieldExtract', 'integer', 'Extract `bits` bits of `value` starting at bit `offset`. Signed types sign-extend, unsigned types zero-extend.', [
    'genIType bitfieldExtract(genIType value, int offset, int bits)',
    'genUType bitfieldExtract(genUType value, int offset, int bits)',
  ], { minVersion: 400 }),
  fn('bitfieldInsert', 'integer', 'Insert the `bits` least significant bits of `insert` into `base` at bit `offset`.', [
    'genIType bitfieldInsert(genIType base, genIType insert, int offset, int bits)',
    'genUType bitfieldInsert(genUType base, genUType insert, int offset, int bits)',
  ], { minVersion: 400 }),
  fn('bitfieldReverse', 'integer', 'Reverse the order of the bits.', ['genIType bitfieldReverse(genIType value)', 'genUType bitfieldReverse(genUType value)'], { minVersion: 400 }),
  fn('bitCount', 'integer', 'Number of bits set to 1.', ['genIType bitCount(genIType value)', 'genIType bitCount(genUType value)'], { minVersion: 400 }),
  fn('findLSB', 'integer', 'Index of the least significant set bit, or `-1` if the value is zero.', ['genIType findLSB(genIType value)', 'genIType findLSB(genUType value)'], { minVersion: 400 }),
  fn('findMSB', 'integer', 'Index of the most significant set bit (for negative signed values, the most significant zero bit), or `-1`.', ['genIType findMSB(genIType value)', 'genIType findMSB(genUType value)'], { minVersion: 400 }),

  // ---- packing
  fn('packUnorm2x16', 'packing', 'Pack two floats in `[0, 1]` into a `uint` as 16-bit unsigned normalized values (`x` in the low bits).', ['uint packUnorm2x16(vec2 v)'], { minVersion: 400, docPage: 'packUnorm' }),
  fn('packSnorm2x16', 'packing', 'Pack two floats in `[-1, 1]` into a `uint` as 16-bit signed normalized values.', ['uint packSnorm2x16(vec2 v)'], { minVersion: 400, docPage: 'packUnorm' }),
  fn('packUnorm4x8', 'packing', 'Pack four floats in `[0, 1]` into a `uint` as 8-bit unsigned normalized values (`x` in the low bits).', ['uint packUnorm4x8(vec4 v)'], { minVersion: 400, docPage: 'packUnorm' }),
  fn('packSnorm4x8', 'packing', 'Pack four floats in `[-1, 1]` into a `uint` as 8-bit signed normalized values.', ['uint packSnorm4x8(vec4 v)'], { minVersion: 400, docPage: 'packUnorm' }),
  fn('unpackUnorm2x16', 'packing', 'Unpack a `uint` into two floats in `[0, 1]` (inverse of `packUnorm2x16`).', ['vec2 unpackUnorm2x16(uint p)'], { minVersion: 400, docPage: 'unpackUnorm' }),
  fn('unpackSnorm2x16', 'packing', 'Unpack a `uint` into two floats in `[-1, 1]` (inverse of `packSnorm2x16`).', ['vec2 unpackSnorm2x16(uint p)'], { minVersion: 400, docPage: 'unpackUnorm' }),
  fn('unpackUnorm4x8', 'packing', 'Unpack a `uint` into four floats in `[0, 1]` (inverse of `packUnorm4x8`).', ['vec4 unpackUnorm4x8(uint p)'], { minVersion: 400, docPage: 'unpackUnorm' }),
  fn('unpackSnorm4x8', 'packing', 'Unpack a `uint` into four floats in `[-1, 1]` (inverse of `packSnorm4x8`).', ['vec4 unpackSnorm4x8(uint p)'], { minVersion: 400, docPage: 'unpackUnorm' }),
  fn('packHalf2x16', 'packing', 'Pack two floats as 16-bit half floats into a `uint` (`x` in the low bits).', ['uint packHalf2x16(vec2 v)'], { minVersion: 420 }),
  fn('unpackHalf2x16', 'packing', 'Unpack a `uint` holding two half floats into a `vec2`.', ['vec2 unpackHalf2x16(uint v)'], { minVersion: 420 }),
  fn('packDouble2x32', 'packing', 'Pack two `uint` into one `double` (`x` holds the low bits).', ['double packDouble2x32(uvec2 v)'], { minVersion: 400 }),
  fn('unpackDouble2x32', 'packing', 'Unpack a `double` into two `uint` (low bits in `x`).', ['uvec2 unpackDouble2x32(double d)'], { minVersion: 400 }),

  // ---- legacy noise
  fn('noise1', 'noise', 'Legacy noise function returning a float in `[-1, 1]`. Many drivers return 0; prefer a hash or a library such as LYGIA.', ['float noise1(genType x)'], { deprecated: NOISE_DEPRECATED, docPage: 'noise' }),
  fn('noise2', 'noise', 'Legacy noise function returning a `vec2`. Many drivers return 0.', ['vec2 noise2(genType x)'], { deprecated: NOISE_DEPRECATED, docPage: 'noise' }),
  fn('noise3', 'noise', 'Legacy noise function returning a `vec3`. Many drivers return 0.', ['vec3 noise3(genType x)'], { deprecated: NOISE_DEPRECATED, docPage: 'noise' }),
  fn('noise4', 'noise', 'Legacy noise function returning a `vec4`. Many drivers return 0.', ['vec4 noise4(genType x)'], { deprecated: NOISE_DEPRECATED, docPage: 'noise' }),
];
