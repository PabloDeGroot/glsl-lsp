// Builtin GLSL types: scalars, vectors, matrices, samplers and images.
// Generated from small tables so every type has a doc and component info.
// (Named typesData.ts so it does not clash with the type definitions in types.ts.)

import type { BuiltinType } from './types';

const t = (name: string, doc: string, extra: Partial<BuiltinType> = {}): BuiltinType => ({ kind: 'type', name, doc, ...extra });

const scalars: BuiltinType[] = [
  t('void', 'No value. Return type of functions that return nothing.'),
  t('bool', 'A boolean: `true` or `false`.'),
  t('int', 'A signed 32-bit integer.'),
  t('uint', 'An unsigned 32-bit integer. Literals take a `u` suffix (`1u`).', { minVersion: 130 }),
  t('float', 'A single-precision floating-point scalar.'),
  t('double', 'A double-precision floating-point scalar. Literals take an `lf` suffix (`1.0lf`).', { minVersion: 400 }),
];

const VEC_PREFIX: [string, string, string, number | undefined][] = [
  ['', 'float', 'single-precision floating-point', undefined],
  ['d', 'double', 'double-precision floating-point', 400],
  ['i', 'int', 'signed integer', undefined],
  ['u', 'uint', 'unsigned integer', 130],
  ['b', 'bool', 'boolean', undefined],
];
const WORDS = ['', '', 'two', 'three', 'four'];

const vectors: BuiltinType[] = VEC_PREFIX.flatMap(([prefix, comp, desc, ver]) =>
  [2, 3, 4].map((n) =>
    t(`${prefix}vec${n}`, `A ${WORDS[n]}-component ${desc} vector. Components: \`xyzw\`, \`rgba\` or \`stpq\`; swizzles like \`.${'xyzw'.slice(0, n)}\` are allowed.`, {
      componentType: comp,
      components: n,
      ...(ver ? { minVersion: ver } : {}),
    }),
  ),
);

const matrices: BuiltinType[] = [];
for (const [prefix, comp, desc, ver] of [['', 'float', 'single', undefined], ['d', 'double', 'double', 400]] as const) {
  for (const c of [2, 3, 4]) {
    for (const r of [2, 3, 4]) {
      const square = c === r;
      const doc = `A ${c}-column, ${r}-row ${desc}-precision matrix, stored column-major: \`m[column][row]\`.`;
      if (square) matrices.push(t(`${prefix}mat${c}`, doc, { componentType: comp, components: c * r, ...(ver ? { minVersion: ver } : {}) }));
      matrices.push(t(`${prefix}mat${c}x${r}`, doc, { componentType: comp, components: c * r, minVersion: ver ?? (square ? undefined : 120) }));
    }
  }
}

const SAMPLER_KINDS: [string, string][] = [
  ['1D', '1D texture'],
  ['2D', '2D texture'],
  ['3D', '3D texture'],
  ['Cube', 'cube map texture'],
  ['2DRect', 'rectangle texture (unnormalized coordinates)'],
  ['1DArray', '1D array texture'],
  ['2DArray', '2D array texture'],
  ['CubeArray', 'cube map array texture'],
  ['Buffer', 'buffer texture'],
  ['2DMS', 'multisample 2D texture'],
  ['2DMSArray', 'multisample 2D array texture'],
];
const SHADOW_KINDS = ['1D', '2D', 'Cube', '2DRect', '1DArray', '2DArray', 'CubeArray'];
const G_PREFIX: [string, string][] = [['', 'floating-point'], ['i', 'signed integer'], ['u', 'unsigned integer']];

const samplers: BuiltinType[] = [];
for (const [kind, desc] of SAMPLER_KINDS) {
  for (const [p, texel] of G_PREFIX) {
    const ver = kind === 'CubeArray' ? 400 : kind === 'Buffer' || kind === '2DMS' || kind === '2DMSArray' ? 140 : p ? 130 : undefined;
    samplers.push(t(`${p}sampler${kind}`, `A handle for sampling a ${texel} ${desc}. Use with \`texture\`, \`texelFetch\`, \`textureSize\`...`, ver ? { minVersion: ver } : {}));
  }
}
for (const kind of SHADOW_KINDS) {
  samplers.push(t(`sampler${kind}Shadow`, `A handle for depth-comparison sampling of a ${kind} depth texture. Lookups return a float result of the comparison.`));
}
samplers.push(t('samplerExternalOES', 'A handle for external textures such as camera or video frames (needs `GL_OES_EGL_image_external`).'));

const IMAGE_KINDS = ['1D', '2D', '3D', 'Cube', '2DRect', '1DArray', '2DArray', 'CubeArray', 'Buffer', '2DMS', '2DMSArray'];
const images: BuiltinType[] = [];
for (const kind of IMAGE_KINDS) {
  for (const [p, texel] of G_PREFIX) {
    images.push(t(`${p}image${kind}`, `A handle for loading and storing a ${texel} ${kind} image with \`imageLoad\`/\`imageStore\`. Needs a format layout qualifier unless readonly.`, { minVersion: 420 }));
  }
}

export const builtinTypes: BuiltinType[] = [
  ...scalars,
  ...vectors,
  ...matrices,
  ...samplers,
  ...images,
  t('atomic_uint', 'An atomic counter handle, declared with `layout(binding = N, offset = M) uniform atomic_uint`.', { minVersion: 420 }),
  t('color3', 'shader-toy extension: type of `#iUniform color3 name = color3(r, g, b)`. Shows a colour picker in VS Code and is a `vec3` in the shader.', { shadertoy: true, componentType: 'float', components: 3 }),
];
