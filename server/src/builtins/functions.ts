// Builtin GLSL functions (GLSL 4.60 and GLSL ES 3.x). The data is split over
// several files by topic; this one just concatenates it. See ./define.ts for
// the compact signature notation.

import type { BuiltinFunction } from './types';
import {
  atomicFunctions,
  barrierFunctions,
  derivativeFunctions,
  geometryFunctions,
  imageFunctions,
  interpolationFunctions,
} from './functionsMisc';
import { mathFunctions } from './functionsMath';
import { mathFunctions2 } from './functionsMath2';
import { textureFunctions } from './functionsTexture';

export const builtinFunctions: BuiltinFunction[] = [
  ...mathFunctions,
  ...mathFunctions2,
  ...textureFunctions,
  ...derivativeFunctions,
  ...interpolationFunctions,
  ...imageFunctions,
  ...atomicFunctions,
  ...barrierFunctions,
  ...geometryFunctions,
];
