// Builtin texture functions. The many overloads are generated from a table of
// sampler families rather than written out by hand; the data still ends up as
// ordinary BuiltinFunction entries with concrete parameter types.

import { fn } from './define';
import type { BuiltinFunction } from './types';

interface Family {
  /** Sampler name, with the `g` prefix for the generic (float/int/uint) flavour. */
  sampler: string;
  /** Shadow flavour of the sampler, if any. */
  shadow?: string;
  /** Texture coordinate type. */
  P: string;
  /** Coordinate type of the shadow flavour (includes the reference value). */
  shadowP?: string;
  /** Integer offset type; absent when the family has no offset variants. */
  offset?: string;
  /** Gradient type. */
  grad?: string;
  /** textureSize result. */
  size: string;
  /** Coordinate type of textureProj, and its 4 component variant. */
  proj?: string[];
  /** Whether textureLod / mipmap levels exist. */
  lod: boolean;
  /** Integer coordinate type of texelFetch. */
  fetch?: string;
  /** texelFetch takes a `sample` index instead of `lod`. */
  fetchSample?: boolean;
  gather?: boolean;
  /** Plain `texture()` is allowed. */
  sample: boolean;
}

const FAMILIES: Family[] = [
  { sampler: 'gsampler1D', shadow: 'sampler1DShadow', P: 'float', shadowP: 'vec3', offset: 'int', grad: 'float', size: 'int', proj: ['vec2', 'vec4'], lod: true, fetch: 'int', sample: true },
  { sampler: 'gsampler2D', shadow: 'sampler2DShadow', P: 'vec2', shadowP: 'vec3', offset: 'ivec2', grad: 'vec2', size: 'ivec2', proj: ['vec3', 'vec4'], lod: true, fetch: 'ivec2', gather: true, sample: true },
  { sampler: 'gsampler3D', P: 'vec3', offset: 'ivec3', grad: 'vec3', size: 'ivec3', proj: ['vec4'], lod: true, fetch: 'ivec3', sample: true },
  { sampler: 'gsamplerCube', shadow: 'samplerCubeShadow', P: 'vec3', shadowP: 'vec4', grad: 'vec3', size: 'ivec2', lod: true, gather: true, sample: true },
  { sampler: 'gsampler2DRect', shadow: 'sampler2DRectShadow', P: 'vec2', shadowP: 'vec3', offset: 'ivec2', grad: 'vec2', size: 'ivec2', proj: ['vec3', 'vec4'], lod: false, fetch: 'ivec2', gather: true, sample: true },
  { sampler: 'gsampler1DArray', shadow: 'sampler1DArrayShadow', P: 'vec2', shadowP: 'vec3', offset: 'int', grad: 'float', size: 'ivec2', lod: true, fetch: 'ivec2', sample: true },
  { sampler: 'gsampler2DArray', shadow: 'sampler2DArrayShadow', P: 'vec3', shadowP: 'vec4', offset: 'ivec2', grad: 'vec2', size: 'ivec3', lod: true, fetch: 'ivec3', gather: true, sample: true },
  { sampler: 'gsamplerCubeArray', shadow: 'samplerCubeArrayShadow', P: 'vec4', shadowP: 'vec4', grad: 'vec3', size: 'ivec3', lod: true, gather: true, sample: true },
  { sampler: 'gsamplerBuffer', P: 'int', size: 'int', lod: false, fetch: 'int', sample: false },
  { sampler: 'gsampler2DMS', P: 'ivec2', size: 'ivec2', lod: false, fetch: 'ivec2', fetchSample: true, sample: false },
  { sampler: 'gsampler2DMSArray', P: 'ivec3', size: 'ivec3', lod: false, fetch: 'ivec3', fetchSample: true, sample: false },
];

const GV = 'gvec4';

interface Variant {
  sampler: string;
  P: string;
  ret: string;
  fam: Family;
  isShadow: boolean;
}

function variants(f: Family, pick: (f: Family) => boolean = () => true): Variant[] {
  if (!pick(f)) return [];
  const out: Variant[] = [{ sampler: f.sampler, P: f.P, ret: GV, fam: f, isShadow: false }];
  if (f.shadow && f.shadowP) out.push({ sampler: f.shadow, P: f.shadowP, ret: 'float', fam: f, isShadow: true });
  return out;
}

function all(pick: (f: Family) => boolean): Variant[] {
  return FAMILIES.flatMap((f) => variants(f, pick));
}

function sig(ret: string, name: string, params: string[], version?: number): string {
  return `${version ? `@${version} ` : ''}${ret} ${name}(${params.join(', ')})`;
}

/** Cube-array shadow takes the reference as a separate argument. */
function needsRef(v: Variant): boolean {
  return v.sampler === 'samplerCubeArrayShadow';
}

type ParamLists = string[] | string[][] | undefined;

function lists(x: ParamLists): string[][] {
  if (!x || x.length === 0) return x ? [[]] : [];
  return Array.isArray(x[0]) ? (x as string[][]) : [x as string[]];
}

function build(name: string, doc: string, make: (v: Variant) => ParamLists, pick: (f: Family) => boolean, minVersion?: number): BuiltinFunction {
  const sigs: string[] = [];
  for (const v of all(pick)) {
    for (const params of lists(make(v))) sigs.push(sig(v.ret, name, params));
  }
  return fn(name, 'texture', doc, sigs, { docPage: name, minVersion });
}

const S = (v: Variant) => `${v.sampler} sampler`;
const hasSample = (f: Family) => f.sample;
const hasOffset = (f: Family) => f.sample && !!f.offset;
const hasProj = (f: Family) => !!f.proj;
const hasLod = (f: Family) => f.sample && f.lod;

function projVariants(): Variant[] {
  return FAMILIES.filter(hasProj).flatMap((f) => {
    const out: Variant[] = [];
    for (const p of f.proj ?? []) out.push({ sampler: f.sampler, P: p, ret: GV, fam: f, isShadow: false });
    if (f.shadow) out.push({ sampler: f.shadow, P: 'vec4', ret: 'float', fam: f, isShadow: true });
    return out;
  });
}

function buildProj(name: string, doc: string, extra: (v: Variant) => ParamLists, offset: boolean): BuiltinFunction {
  const sigs: string[] = [];
  for (const v of projVariants()) {
    if (offset && !v.fam.offset) continue;
    if (name.includes('Lod') && !v.fam.lod) continue;
    for (const x of lists(extra(v))) sigs.push(`${v.ret} ${name}(${[S(v), `${v.P} P`, ...x].join(', ')})`);
  }
  return fn(name, 'texture', doc, sigs, { docPage: name, minVersion: 130 });
}

const texture: BuiltinFunction[] = [
  build('texture', 'Sample a texture at coordinate `P`, with an optional LOD `bias` (fragment shaders only). Shadow samplers compare the reference value stored in the last component of `P`.', (v) => {
    if (needsRef(v)) return [S(v), `${v.P} P`, 'float compare'];
    const base = [S(v), `${v.P} P`];
    // Shadow samplers have no bias overload except for 1D/2D/Rect/Cube in GLSL 4.
    return [base, [...base, 'float bias']];
  }, hasSample, 130),
  build('textureLod', 'Sample a texture at coordinate `P` using the explicit mip level `lod`.', (v) => (needsRef(v) ? undefined : [S(v), `${v.P} P`, 'float lod']), hasLod, 130),
  build('textureOffset', 'Sample a texture with a constant integer `offset` (in texels) added to the lookup. `offset` must be a constant expression.', (v) => (v.fam.offset ? [[S(v), `${v.P} P`, `${v.fam.offset} offset`], [S(v), `${v.P} P`, `${v.fam.offset} offset`, 'float bias']] : undefined), hasOffset, 130),
  build('texelFetch', 'Fetch a single texel by integer coordinate, with no filtering or wrapping. The last argument is the mip level `lod` (or the sample index for multisample samplers).', (v) => {
    const f = v.fam;
    if (!f.fetch || v.isShadow) return undefined;
    const base = [S(v), `${f.fetch} P`];
    if (f.fetchSample) return [...base, 'int sample'];
    return f.lod ? [...base, 'int lod'] : base;
  }, (f) => !!f.fetch, 130),
  build('texelFetchOffset', 'Fetch a single texel by integer coordinate with a constant integer `offset` added.', (v) => (v.fam.offset && v.fam.fetch && !v.isShadow ? [S(v), `${v.fam.fetch} P`, 'int lod', `${v.fam.offset} offset`] : undefined), (f) => !!f.offset && !!f.fetch, 130),
  build('textureGrad', 'Sample a texture using explicit gradients `dPdx` and `dPdy` to select the mip level and anisotropic footprint.', (v) => (v.fam.grad && !needsRef(v) ? [S(v), `${v.P} P`, `${v.fam.grad} dPdx`, `${v.fam.grad} dPdy`] : undefined), (f) => f.sample && !!f.grad, 130),
  build('textureGradOffset', 'Sample a texture with explicit gradients and a constant integer `offset`.', (v) => (v.fam.grad && v.fam.offset ? [S(v), `${v.P} P`, `${v.fam.grad} dPdx`, `${v.fam.grad} dPdy`, `${v.fam.offset} offset`] : undefined), (f) => f.sample && !!f.grad && !!f.offset, 130),
  build('textureLodOffset', 'Sample a texture at an explicit mip level with a constant integer `offset`.', (v) => (v.fam.offset ? [S(v), `${v.P} P`, 'float lod', `${v.fam.offset} offset`] : undefined), (f) => f.sample && f.lod && !!f.offset, 130),
  buildProj('textureProj', 'Projective texture lookup: `P` is divided by its last component before sampling. Optional LOD `bias` (fragment shaders only).', (v) => [[], ['float bias']], false),
  buildProj('textureProjOffset', 'Projective texture lookup with a constant integer `offset`.', (v) => (v.fam.offset ? [[`${v.fam.offset} offset`], [`${v.fam.offset} offset`, 'float bias']] : undefined), true),
  buildProj('textureProjLod', 'Projective texture lookup at an explicit mip level.', () => ['float lod'], false),
  buildProj('textureProjLodOffset', 'Projective texture lookup at an explicit mip level with a constant integer `offset`.', (v) => (v.fam.offset ? ['float lod', `${v.fam.offset} offset`] : undefined), true),
  buildProj('textureProjGrad', 'Projective texture lookup with explicit gradients.', (v) => (v.fam.grad ? [`${v.fam.grad} dPdx`, `${v.fam.grad} dPdy`] : undefined), false),
  buildProj('textureProjGradOffset', 'Projective texture lookup with explicit gradients and a constant integer `offset`.', (v) => (v.fam.grad && v.fam.offset ? [`${v.fam.grad} dPdx`, `${v.fam.grad} dPdy`, `${v.fam.offset} offset`] : undefined), true),
];

// textureSize: `(sampler, lod)`, or just `(sampler)` for rect, buffer and multisample samplers.
function textureSize(): BuiltinFunction {
  const sigs: string[] = [];
  for (const v of all((fam) => fam.sample || !!fam.fetch)) {
    const noLod = !v.fam.lod || v.fam.sampler.includes('MS');
    sigs.push(sig(v.fam.size, 'textureSize', noLod ? [S(v)] : [S(v), 'int lod']));
  }
  return fn('textureSize', 'texture', 'Size in texels of the given mip level of a texture. For array samplers the last component is the layer count.', sigs, { minVersion: 130, docPage: 'textureSize' });
}

// textureGather family.
function gather(name: string, extra: (v: Variant) => string[] | undefined, doc: string): BuiltinFunction {
  const sigs: string[] = [];
  for (const v of all((f) => !!f.gather)) {
    const x = extra(v);
    if (!x) continue;
    const comp = v.isShadow ? [] : ['int comp'];
    sigs.push(v.isShadow ? `${GV} ${name}(${[S(v), `${v.P} P`, 'float refZ', ...x].join(', ')})` : `${GV} ${name}(${[S(v), `${v.P} P`, ...x].concat(comp).join(', ')})`);
  }
  return fn(name, 'texture', doc, sigs, { minVersion: 400, docPage: name });
}

const gathers: BuiltinFunction[] = [
  gather('textureGather', () => [], 'Gather the four texels that a bilinear lookup would use and return the selected component (`comp`, 0 to 3, default 0) of each as a `vec4`.'),
  gather('textureGatherOffset', (v) => (v.fam.offset ? [`${v.fam.offset} offset`] : undefined), 'Like `textureGather`, with a constant integer `offset` added to the lookup.'),
  gather('textureGatherOffsets', (v) => (v.fam.offset ? [`${v.fam.offset} offsets[4]`] : undefined), 'Like `textureGather`, with a separate constant offset for each of the four texels.'),
];

// ---------------------------------------------------------------- queries
const queries: BuiltinFunction[] = [
  fn('textureQueryLod', 'texture', 'Return the mip level that would be used to sample at `P`: `x` is the level of detail for the accessed mip chain (including fractional part), `y` is the clamped LOD relative to the base level. Fragment shaders only.', [
    'vec2 textureQueryLod(gsampler1D sampler, float P)',
    'vec2 textureQueryLod(gsampler2D sampler, vec2 P)',
    'vec2 textureQueryLod(gsampler3D sampler, vec3 P)',
    'vec2 textureQueryLod(gsamplerCube sampler, vec3 P)',
    'vec2 textureQueryLod(gsampler1DArray sampler, float P)',
    'vec2 textureQueryLod(gsampler2DArray sampler, vec2 P)',
    'vec2 textureQueryLod(gsamplerCubeArray sampler, vec3 P)',
  ], { minVersion: 400, stages: ['fragment'] }),
  fn('textureQueryLevels', 'texture', 'Number of accessible mip levels of the texture.', [
    'int textureQueryLevels(gsampler1D sampler)',
    'int textureQueryLevels(gsampler2D sampler)',
    'int textureQueryLevels(gsampler3D sampler)',
    'int textureQueryLevels(gsamplerCube sampler)',
    'int textureQueryLevels(gsampler2DArray sampler)',
  ], { minVersion: 430 }),
  fn('textureSamples', 'texture', 'Number of samples of a multisample texture.', [
    'int textureSamples(gsampler2DMS sampler)',
    'int textureSamples(gsampler2DMSArray sampler)',
  ], { minVersion: 450 }),
];

// ---------------------------------------------------------------- legacy
const LEG = (n: string, doc: string, sigs: string[], opts: { stages?: ('vertex' | 'fragment')[]; ver?: number } = {}) =>
  fn(n, 'texture', doc, sigs, { deprecated: 'Legacy name; use `texture` / `textureLod` / `textureProj` in GLSL 1.30 and ES 3.0.', docPage: false, minVersion: opts.ver, stages: opts.stages });

const legacy: BuiltinFunction[] = [
  LEG('texture1D', 'Legacy 1D texture lookup (optional LOD `bias`).', ['vec4 texture1D(sampler1D sampler, float coord)', 'vec4 texture1D(sampler1D sampler, float coord, float bias)']),
  LEG('texture1DProj', 'Legacy projective 1D texture lookup.', ['vec4 texture1DProj(sampler1D sampler, vec2 coord)', 'vec4 texture1DProj(sampler1D sampler, vec4 coord)']),
  LEG('texture1DLod', 'Legacy 1D texture lookup at an explicit mip level.', ['vec4 texture1DLod(sampler1D sampler, float coord, float lod)'], { stages: ['vertex'] }),
  LEG('texture2D', 'Legacy 2D texture lookup (GLSL ES 1.00 / WebGL 1 style); optional LOD `bias` in fragment shaders.', ['vec4 texture2D(sampler2D sampler, vec2 coord)', 'vec4 texture2D(sampler2D sampler, vec2 coord, float bias)']),
  LEG('texture2DProj', 'Legacy projective 2D texture lookup.', ['vec4 texture2DProj(sampler2D sampler, vec3 coord)', 'vec4 texture2DProj(sampler2D sampler, vec4 coord)', 'vec4 texture2DProj(sampler2D sampler, vec3 coord, float bias)', 'vec4 texture2DProj(sampler2D sampler, vec4 coord, float bias)']),
  LEG('texture2DLod', 'Legacy 2D texture lookup at an explicit mip level.', ['vec4 texture2DLod(sampler2D sampler, vec2 coord, float lod)']),
  LEG('texture2DProjLod', 'Legacy projective 2D texture lookup at an explicit mip level.', ['vec4 texture2DProjLod(sampler2D sampler, vec3 coord, float lod)', 'vec4 texture2DProjLod(sampler2D sampler, vec4 coord, float lod)']),
  LEG('texture3D', 'Legacy 3D texture lookup.', ['vec4 texture3D(sampler3D sampler, vec3 coord)', 'vec4 texture3D(sampler3D sampler, vec3 coord, float bias)']),
  LEG('texture3DProj', 'Legacy projective 3D texture lookup.', ['vec4 texture3DProj(sampler3D sampler, vec4 coord)']),
  LEG('texture3DLod', 'Legacy 3D texture lookup at an explicit mip level.', ['vec4 texture3DLod(sampler3D sampler, vec3 coord, float lod)']),
  LEG('textureCube', 'Legacy cube map lookup.', ['vec4 textureCube(samplerCube sampler, vec3 coord)', 'vec4 textureCube(samplerCube sampler, vec3 coord, float bias)']),
  LEG('textureCubeLod', 'Legacy cube map lookup at an explicit mip level.', ['vec4 textureCubeLod(samplerCube sampler, vec3 coord, float lod)']),
  LEG('shadow1D', 'Legacy 1D shadow lookup.', ['vec4 shadow1D(sampler1DShadow sampler, vec3 coord)', 'vec4 shadow1D(sampler1DShadow sampler, vec3 coord, float bias)']),
  LEG('shadow2D', 'Legacy 2D shadow lookup.', ['vec4 shadow2D(sampler2DShadow sampler, vec3 coord)', 'vec4 shadow2D(sampler2DShadow sampler, vec3 coord, float bias)']),
];

export const textureFunctions: BuiltinFunction[] = [...texture, textureSize(), ...gathers, ...queries, ...legacy];
