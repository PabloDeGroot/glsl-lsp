// Builtin functions: trigonometry, exponentials, common, geometric, matrix,
// vector relational, integer and packing functions.

import { fn } from './define';
import type { BuiltinFunction } from './types';

const F = (n: string) => `genType ${n}(genType x)`;

export const mathFunctions: BuiltinFunction[] = [
  // ---- angle and trigonometry
  fn('radians', 'trigonometry', 'Convert degrees to radians: `degrees * PI / 180`.', [F('radians').replace('x', 'degrees')]),
  fn('degrees', 'trigonometry', 'Convert radians to degrees: `radians * 180 / PI`.', [F('degrees').replace('x', 'radians')]),
  fn('sin', 'trigonometry', 'Sine of an angle in radians.', [F('sin').replace('x', 'angle')]),
  fn('cos', 'trigonometry', 'Cosine of an angle in radians.', [F('cos').replace('x', 'angle')]),
  fn('tan', 'trigonometry', 'Tangent of an angle in radians.', [F('tan').replace('x', 'angle')]),
  fn('asin', 'trigonometry', 'Arc sine, returning an angle in `[-PI/2, PI/2]`. Undefined if `|x| > 1`.', [F('asin')]),
  fn('acos', 'trigonometry', 'Arc cosine, returning an angle in `[0, PI]`. Undefined if `|x| > 1`.', [F('acos')]),
  fn('atan', 'trigonometry', 'Arc tangent. The two-argument form is `atan2`: the angle of the point `(x, y)` in `(-PI, PI]`, using the signs of both arguments to pick the quadrant. The one-argument form returns an angle in `[-PI/2, PI/2]`.', [
    'genType atan(genType y, genType x)',
    'genType atan(genType y_over_x)',
  ]),
  fn('sinh', 'trigonometry', 'Hyperbolic sine.', [F('sinh')], { minVersion: 130 }),
  fn('cosh', 'trigonometry', 'Hyperbolic cosine.', [F('cosh')], { minVersion: 130 }),
  fn('tanh', 'trigonometry', 'Hyperbolic tangent.', [F('tanh')], { minVersion: 130 }),
  fn('asinh', 'trigonometry', 'Inverse hyperbolic sine.', [F('asinh')], { minVersion: 130 }),
  fn('acosh', 'trigonometry', 'Inverse hyperbolic cosine. Undefined if `x < 1`.', [F('acosh')], { minVersion: 130 }),
  fn('atanh', 'trigonometry', 'Inverse hyperbolic tangent. Undefined if `|x| >= 1`.', [F('atanh')], { minVersion: 130 }),

  // ---- exponential
  fn('pow', 'exponential', 'Raise `x` to the power `y`: `x^y`. Undefined if `x < 0` or if `x == 0 && y <= 0`.', ['genType pow(genType x, genType y)']),
  fn('exp', 'exponential', 'Natural exponentiation: `e^x`.', [F('exp')]),
  fn('log', 'exponential', 'Natural logarithm. Undefined if `x <= 0`.', [F('log')]),
  fn('exp2', 'exponential', 'Raise 2 to the power `x`: `2^x`.', [F('exp2')]),
  fn('log2', 'exponential', 'Base-2 logarithm. Undefined if `x <= 0`.', [F('log2')]),
  fn('sqrt', 'exponential', 'Square root. Undefined if `x < 0`.', [F('sqrt'), '@400 genDType sqrt(genDType x)']),
  fn('inversesqrt', 'exponential', 'Inverse square root: `1 / sqrt(x)`. Undefined if `x <= 0`.', [F('inversesqrt'), '@400 genDType inversesqrt(genDType x)']),

  // ---- common
  fn('abs', 'common', 'Absolute value.', [F('abs'), 'genIType abs(genIType x)', '@400 genDType abs(genDType x)']),
  fn('sign', 'common', 'Sign of `x`: `-1.0`, `0.0` or `1.0`.', [F('sign'), 'genIType sign(genIType x)', '@400 genDType sign(genDType x)']),
  fn('floor', 'common', 'Nearest integer less than or equal to `x`.', [F('floor'), '@400 genDType floor(genDType x)']),
  fn('trunc', 'common', 'Nearest integer whose absolute value is not larger than that of `x` (round toward zero).', [F('trunc'), '@400 genDType trunc(genDType x)'], { minVersion: 130 }),
  fn('round', 'common', 'Nearest integer to `x`. Halves round in an implementation-defined direction; see `roundEven`.', [F('round'), '@400 genDType round(genDType x)'], { minVersion: 130 }),
  fn('roundEven', 'common', 'Nearest integer to `x`; a fractional part of exactly 0.5 rounds to the nearest even integer.', [F('roundEven'), '@400 genDType roundEven(genDType x)'], { minVersion: 130 }),
  fn('ceil', 'common', 'Nearest integer greater than or equal to `x`.', [F('ceil'), '@400 genDType ceil(genDType x)']),
  fn('fract', 'common', 'Fractional part of `x`: `x - floor(x)`.', [F('fract'), '@400 genDType fract(genDType x)']),
  fn('mod', 'common', 'Modulus: `x - y * floor(x / y)`. The result has the sign of `y`, unlike `%` or C `fmod`.', [
    'genType mod(genType x, float y)',
    'genType mod(genType x, genType y)',
    '@400 genDType mod(genDType x, double y)',
    '@400 genDType mod(genDType x, genDType y)',
  ]),
  fn('modf', 'common', 'Split `x` into integer and fractional parts. Returns the fractional part and writes the integer part to `i`; both have the sign of `x`.', [
    'genType modf(genType x, out genType i)',
    '@400 genDType modf(genDType x, out genDType i)',
  ], { minVersion: 130 }),
  fn('min', 'common', 'Smaller of two values.', [
    'genType min(genType x, genType y)',
    'genType min(genType x, float y)',
    'genIType min(genIType x, genIType y)',
    'genIType min(genIType x, int y)',
    'genUType min(genUType x, genUType y)',
    'genUType min(genUType x, uint y)',
    '@400 genDType min(genDType x, genDType y)',
    '@400 genDType min(genDType x, double y)',
  ]),
  fn('max', 'common', 'Larger of two values.', [
    'genType max(genType x, genType y)',
    'genType max(genType x, float y)',
    'genIType max(genIType x, genIType y)',
    'genIType max(genIType x, int y)',
    'genUType max(genUType x, genUType y)',
    'genUType max(genUType x, uint y)',
    '@400 genDType max(genDType x, genDType y)',
    '@400 genDType max(genDType x, double y)',
  ]),
  fn('clamp', 'common', 'Constrain `x` to `[minVal, maxVal]`: `min(max(x, minVal), maxVal)`. Undefined if `minVal > maxVal`.', [
    'genType clamp(genType x, genType minVal, genType maxVal)',
    'genType clamp(genType x, float minVal, float maxVal)',
    'genIType clamp(genIType x, genIType minVal, genIType maxVal)',
    'genIType clamp(genIType x, int minVal, int maxVal)',
    'genUType clamp(genUType x, genUType minVal, genUType maxVal)',
    'genUType clamp(genUType x, uint minVal, uint maxVal)',
    '@400 genDType clamp(genDType x, genDType minVal, genDType maxVal)',
    '@400 genDType clamp(genDType x, double minVal, double maxVal)',
  ]),
];
