// Builtin functions: derivatives, interpolation, image, atomic, barrier and
// geometry shader functions.

import { fn } from './define';
import type { BuiltinFunction } from './types';

const FRAG = ['fragment' as const];
const COMPUTE = ['compute' as const];

const deriv = (name: string, doc: string, v: number | undefined, page: string) =>
  fn(name, 'derivative', doc, [`genType ${name}(genType p)`], { stages: FRAG, minVersion: v, docPage: page });

export const derivativeFunctions: BuiltinFunction[] = [
  deriv('dFdx', 'Partial derivative of `p` with respect to window x. Fragment shaders only. Precision is implementation dependent; see `dFdxFine`/`dFdxCoarse`.', undefined, 'dFdx'),
  deriv('dFdy', 'Partial derivative of `p` with respect to window y. Fragment shaders only.', undefined, 'dFdx'),
  deriv('dFdxFine', 'Derivative with respect to x using the values of the current pixel and its horizontal neighbour (higher precision).', 450, 'dFdx'),
  deriv('dFdyFine', 'Derivative with respect to y using the values of the current pixel and its vertical neighbour (higher precision).', 450, 'dFdx'),
  deriv('dFdxCoarse', 'Derivative with respect to x computed once for the whole 2x2 quad (cheaper, lower precision).', 450, 'dFdx'),
  deriv('dFdyCoarse', 'Derivative with respect to y computed once for the whole 2x2 quad (cheaper, lower precision).', 450, 'dFdx'),
  deriv('fwidth', 'Sum of absolute derivatives in x and y: `abs(dFdx(p)) + abs(dFdy(p))`. Handy for anti-aliasing edges.', undefined, 'fwidth'),
  deriv('fwidthFine', '`abs(dFdxFine(p)) + abs(dFdyFine(p))`.', 450, 'fwidth'),
  deriv('fwidthCoarse', '`abs(dFdxCoarse(p)) + abs(dFdyCoarse(p))`.', 450, 'fwidth'),
];

export const interpolationFunctions: BuiltinFunction[] = [
  fn('interpolateAtCentroid', 'interpolation', 'Value of the input `interpolant` interpolated at the centroid of the covered part of the pixel.', ['genType interpolateAtCentroid(genType interpolant)'], { minVersion: 400, stages: FRAG }),
  fn('interpolateAtSample', 'interpolation', 'Value of the input `interpolant` interpolated at the location of sample number `sample`.', ['genType interpolateAtSample(genType interpolant, int sample)'], { minVersion: 400, stages: FRAG }),
  fn('interpolateAtOffset', 'interpolation', 'Value of the input `interpolant` interpolated at `offset` pixels from the pixel centre (range is implementation dependent).', ['genType interpolateAtOffset(genType interpolant, vec2 offset)'], { minVersion: 400, stages: FRAG }),
];

// ---- image load/store/atomics: generated from a family table.
const IMAGES: [string, string][] = [
  ['gimage1D', 'int'], ['gimage2D', 'ivec2'], ['gimage3D', 'ivec3'], ['gimageCube', 'ivec3'], ['gimage2DRect', 'ivec2'],
  ['gimage1DArray', 'ivec2'], ['gimage2DArray', 'ivec3'], ['gimageCubeArray', 'ivec3'], ['gimageBuffer', 'int'],
];
const MS_IMAGES: [string, string][] = [['gimage2DMS', 'ivec2'], ['gimage2DMSArray', 'ivec3']];
const SIZE: Record<string, string> = {
  gimage1D: 'int', gimage2D: 'ivec2', gimage3D: 'ivec3', gimageCube: 'ivec2', gimage2DRect: 'ivec2', gimage1DArray: 'ivec2',
  gimage2DArray: 'ivec3', gimageCubeArray: 'ivec3', gimageBuffer: 'int', gimage2DMS: 'ivec2', gimage2DMSArray: 'ivec3',
};

function atomicImage(name: string, doc: string, extra: string[]): BuiltinFunction {
  const sigs: string[] = [];
  for (const [img, p] of IMAGES) {
    for (const [pre, t] of [['i', 'int'], ['u', 'uint']] as const) {
      const rest = extra.map((e) => `${t} ${e}`).join(', ');
      sigs.push(`${t} ${name}(${pre}${img.slice(1)} image, ${p} P, ${rest})`);
    }
  }
  return fn(name, 'image', doc, sigs, { minVersion: 420, docPage: name });
}

export const imageFunctions: BuiltinFunction[] = [
  fn('imageLoad', 'image', 'Read one texel from an image at integer coordinate `P` (and sample number for multisample images). The image must be declared with a format layout qualifier unless it is `readonly`.', [
    ...IMAGES.map(([i, p]) => `gvec4 imageLoad(${i} image, ${p} P)`),
    ...MS_IMAGES.map(([i, p]) => `gvec4 imageLoad(${i} image, ${p} P, int sample)`),
  ], { minVersion: 420 }),
  fn('imageStore', 'image', 'Write one texel to an image at integer coordinate `P`.', [
    ...IMAGES.map(([i, p]) => `void imageStore(${i} image, ${p} P, gvec4 data)`),
    ...MS_IMAGES.map(([i, p]) => `void imageStore(${i} image, ${p} P, int sample, gvec4 data)`),
  ], { minVersion: 420 }),
  fn('imageSize', 'image', 'Dimensions of an image. For array images the last component is the layer count.', [...IMAGES, ...MS_IMAGES].map(([i]) => `${SIZE[i]} imageSize(${i} image)`), { minVersion: 420 }),
  fn('imageSamples', 'image', 'Number of samples of a multisample image.', MS_IMAGES.map(([i]) => `int imageSamples(${i} image)`), { minVersion: 450 }),
  atomicImage('imageAtomicAdd', 'Atomically add `data` to the texel and return the original value.', ['data']),
  atomicImage('imageAtomicMin', 'Atomically store the minimum of `data` and the texel; returns the original value.', ['data']),
  atomicImage('imageAtomicMax', 'Atomically store the maximum of `data` and the texel; returns the original value.', ['data']),
  atomicImage('imageAtomicAnd', 'Atomically AND `data` into the texel; returns the original value.', ['data']),
  atomicImage('imageAtomicOr', 'Atomically OR `data` into the texel; returns the original value.', ['data']),
  atomicImage('imageAtomicXor', 'Atomically XOR `data` into the texel; returns the original value.', ['data']),
  atomicImage('imageAtomicExchange', 'Atomically replace the texel with `data`; returns the original value.', ['data']),
  atomicImage('imageAtomicCompSwap', 'Atomically replace the texel with `data` if it equals `compare`; returns the original value.', ['compare', 'data']),
];

const atomicMem = (name: string, doc: string, extra: string[]) =>
  fn(name, 'atomic', doc, ['uint', 'int'].map((t) => `${t} ${name}(inout ${t} mem, ${extra.map((e) => `${t} ${e}`).join(', ')})`), { minVersion: 430, docPage: name });

export const atomicFunctions: BuiltinFunction[] = [
  fn('atomicCounter', 'atomic', 'Read the current value of an atomic counter.', ['uint atomicCounter(atomic_uint c)'], { minVersion: 420 }),
  fn('atomicCounterIncrement', 'atomic', 'Atomically increment an atomic counter and return its previous value.', ['uint atomicCounterIncrement(atomic_uint c)'], { minVersion: 420 }),
  fn('atomicCounterDecrement', 'atomic', 'Atomically decrement an atomic counter and return its new value.', ['uint atomicCounterDecrement(atomic_uint c)'], { minVersion: 420 }),
  atomicMem('atomicAdd', 'Atomically add `data` to `mem` (a buffer or shared variable); returns the original value.', ['data']),
  atomicMem('atomicMin', 'Atomically store the minimum of `data` and `mem`; returns the original value.', ['data']),
  atomicMem('atomicMax', 'Atomically store the maximum of `data` and `mem`; returns the original value.', ['data']),
  atomicMem('atomicAnd', 'Atomically AND `data` into `mem`; returns the original value.', ['data']),
  atomicMem('atomicOr', 'Atomically OR `data` into `mem`; returns the original value.', ['data']),
  atomicMem('atomicXor', 'Atomically XOR `data` into `mem`; returns the original value.', ['data']),
  atomicMem('atomicExchange', 'Atomically replace `mem` with `data`; returns the original value.', ['data']),
  atomicMem('atomicCompSwap', 'Atomically replace `mem` with `data` if it equals `compare`; returns the original value.', ['compare', 'data']),
];

export const barrierFunctions: BuiltinFunction[] = [
  fn('barrier', 'barrier', 'Synchronize all invocations of the work group (compute) or patch (tessellation control): execution resumes only after all have reached this call.', ['void barrier()'], { minVersion: 150, stages: ['compute', 'tessControl'] }),
  fn('memoryBarrier', 'barrier', 'Order all memory writes (buffers, images, atomic counters, shared variables) made by this invocation before later ones.', ['void memoryBarrier()'], { minVersion: 420 }),
  fn('memoryBarrierAtomicCounter', 'barrier', 'Order atomic counter writes made by this invocation.', ['void memoryBarrierAtomicCounter()'], { minVersion: 420 }),
  fn('memoryBarrierBuffer', 'barrier', 'Order buffer variable writes made by this invocation.', ['void memoryBarrierBuffer()'], { minVersion: 430 }),
  fn('memoryBarrierShared', 'barrier', 'Order shared variable writes made by this invocation.', ['void memoryBarrierShared()'], { minVersion: 430, stages: COMPUTE }),
  fn('memoryBarrierImage', 'barrier', 'Order image writes made by this invocation.', ['void memoryBarrierImage()'], { minVersion: 420 }),
  fn('groupMemoryBarrier', 'barrier', 'Order all memory writes by this invocation relative to other invocations in the same work group.', ['void groupMemoryBarrier()'], { minVersion: 430, stages: COMPUTE }),
];

export const geometryFunctions: BuiltinFunction[] = [
  fn('EmitVertex', 'geometry', 'Emit the current values of the output variables as a new vertex of the output primitive.', ['void EmitVertex()'], { minVersion: 150, stages: ['geometry'] }),
  fn('EndPrimitive', 'geometry', 'Finish the current output primitive and start a new one.', ['void EndPrimitive()'], { minVersion: 150, stages: ['geometry'] }),
  fn('EmitStreamVertex', 'geometry', 'Like `EmitVertex`, to the vertex stream number `stream`.', ['void EmitStreamVertex(int stream)'], { minVersion: 400, stages: ['geometry'] }),
  fn('EndStreamPrimitive', 'geometry', 'Like `EndPrimitive`, for the vertex stream number `stream`.', ['void EndStreamPrimitive(int stream)'], { minVersion: 400, stages: ['geometry'] }),
];
