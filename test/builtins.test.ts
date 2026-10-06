import { describe, expect, it } from 'vitest';
import { Builtins, builtinData, getBuiltins } from '../server/src/builtins';
import { parseSignature } from '../server/src/builtins/define';
import { BASIC_TYPES, CONTROL_KEYWORDS, QUALIFIERS } from '../server/src/core/keywords';
import { formatBuiltinFunction } from '../server/src/core/signature';

const b = getBuiltins();
const fns = [...b.functions.values()];

describe('builtin signature parser', () => {
  it('parses qualifiers, versions and names', () => {
    const { name, overload } = parseSignature('@400 genType modf(genType x, out genType i)');
    expect(name).toBe('modf');
    expect(overload.minVersion).toBe(400);
    expect(overload.params.map((p) => [p.type, p.name, p.qualifier])).toEqual([
      ['genType', 'x', undefined],
      ['genType', 'i', 'out'],
    ]);
  });
  it('rejects garbage', () => {
    expect(() => parseSignature('nonsense')).toThrow();
  });
});

describe('builtin functions', () => {
  it('has the whole common set', () => {
    for (const n of [
      'sin', 'cos', 'tan', 'atan', 'pow', 'exp', 'log', 'sqrt', 'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'min', 'max', 'clamp', 'mix',
      'step', 'smoothstep', 'length', 'distance', 'dot', 'cross', 'normalize', 'reflect', 'refract', 'faceforward', 'transpose', 'inverse',
      'determinant', 'outerProduct', 'matrixCompMult', 'lessThan', 'equal', 'any', 'all', 'not', 'texture', 'textureLod', 'texelFetch',
      'textureSize', 'textureGrad', 'textureOffset', 'textureProj', 'textureGather', 'texture2D', 'textureCube', 'dFdx', 'dFdy', 'fwidth',
      'dFdxFine', 'fwidthCoarse', 'bitCount', 'findMSB', 'packHalf2x16', 'unpackUnorm4x8', 'imageLoad', 'imageStore', 'atomicAdd',
      'imageAtomicAdd', 'barrier', 'memoryBarrierShared', 'EmitVertex', 'interpolateAtOffset', 'floatBitsToInt', 'isnan', 'trunc', 'round',
      'roundEven', 'sinh', 'fma', 'frexp', 'ldexp', 'noise1',
    ]) {
      expect(b.functions.has(n), n).toBe(true);
    }
  });

  it('every function has a doc, a category and at least one overload', () => {
    for (const f of fns) {
      expect(f.doc.length, f.name).toBeGreaterThan(5);
      expect(f.category, f.name).toBeTruthy();
      expect(f.overloads.length, f.name).toBeGreaterThan(0);
    }
  });

  it('every non-legacy function links to the Khronos reference', () => {
    for (const f of fns) {
      if (f.shadertoy || f.deprecated) continue;
      expect(f.docUrl, f.name).toMatch(/^https:\/\/registry\.khronos\.org\/OpenGL-Refpages\/gl4\/html\/\w+\.xhtml$/);
    }
  });

  it('has no duplicate signatures', () => {
    for (const f of fns) {
      const sigs = formatBuiltinFunction(f);
      expect(new Set(sigs).size, `${f.name}: ${sigs.join(' | ')}`).toBe(sigs.length);
    }
  });

  it('gives parameters real names', () => {
    for (const f of fns) {
      for (const o of f.overloads) {
        for (const p of o.params) {
          expect(p.name, f.name).toMatch(/^[A-Za-z_]\w*(\[\d+\])?$/);
          expect(p.type, f.name).toBeTruthy();
        }
      }
    }
  });

  it('shows mix(x, y, a) with sensible names', () => {
    const sigs = formatBuiltinFunction(b.functions.get('mix')!);
    expect(sigs).toContain('genType mix(genType x, genType y, float a)');
    expect(sigs.some((s) => s.includes('genBType a'))).toBe(true);
  });

  it('has the expected overload counts for a sample', () => {
    expect(b.functions.get('mix')!.overloads.length).toBe(8);
    expect(b.functions.get('smoothstep')!.overloads.length).toBe(4);
    expect(b.functions.get('clamp')!.overloads.length).toBe(8);
    expect(b.functions.get('length')!.overloads.length).toBe(2);
    expect(b.functions.get('cross')!.overloads.length).toBe(2);
    expect(b.functions.get('equal')!.overloads.length).toBe(4);
    expect(b.functions.get('atan')!.overloads.length).toBe(2);
    expect(b.functions.get('texture')!.overloads.length).toBeGreaterThanOrEqual(18);
    expect(b.functions.get('atomicAdd')!.overloads.length).toBe(2);
  });

  it('expands texture overloads over sampler kinds', () => {
    const sigs = formatBuiltinFunction(b.functions.get('texture')!);
    expect(sigs).toContain('gvec4 texture(gsampler2D sampler, vec2 P)');
    expect(sigs).toContain('gvec4 texture(gsampler2D sampler, vec2 P, float bias)');
    expect(sigs).toContain('gvec4 texture(gsamplerCube sampler, vec3 P)');
    expect(sigs).toContain('float texture(sampler2DShadow sampler, vec3 P)');
    expect(sigs).toContain('float texture(samplerCubeArrayShadow sampler, vec4 P, float compare)');
    const fetch = formatBuiltinFunction(b.functions.get('texelFetch')!);
    expect(fetch).toContain('gvec4 texelFetch(gsampler2D sampler, ivec2 P, int lod)');
    expect(fetch).toContain('gvec4 texelFetch(gsampler2DMS sampler, ivec2 P, int sample)');
    const size = formatBuiltinFunction(b.functions.get('textureSize')!);
    expect(size).toContain('ivec2 textureSize(gsampler2D sampler, int lod)');
    expect(size).toContain('ivec2 textureSize(gsampler2DRect sampler)');
    expect(formatBuiltinFunction(b.functions.get('textureProj')!)).toContain('gvec4 textureProj(gsampler2D sampler, vec3 P)');
    expect(formatBuiltinFunction(b.functions.get('textureLod')!)).toContain('gvec4 textureLod(gsampler2D sampler, vec2 P, float lod)');
    expect(formatBuiltinFunction(b.functions.get('textureGrad')!)).toContain('gvec4 textureGrad(gsampler2D sampler, vec2 P, vec2 dPdx, vec2 dPdy)');
  });

  it('marks legacy texture2D as deprecated and derivatives as fragment-only', () => {
    expect(b.functions.get('texture2D')!.deprecated).toBeTruthy();
    expect(b.functions.get('dFdx')!.stages).toEqual(['fragment']);
    expect(b.functions.get('barrier')!.stages).toContain('compute');
  });
});

describe('builtin variables', () => {
  it('has the stage variables with types and docs', () => {
    const want: Record<string, string> = {
      gl_FragCoord: 'vec4', gl_FragDepth: 'float', gl_FrontFacing: 'bool', gl_PointCoord: 'vec2', gl_Position: 'vec4',
      gl_VertexID: 'int', gl_InstanceID: 'int', gl_GlobalInvocationID: 'uvec3', gl_LocalInvocationID: 'uvec3', gl_WorkGroupID: 'uvec3',
      gl_NumWorkGroups: 'uvec3', gl_PointSize: 'float',
    };
    for (const [n, t] of Object.entries(want)) {
      const v = b.variables.get(n)!;
      expect(v, n).toBeDefined();
      expect(v.type).toBe(t);
      expect(v.doc.length).toBeGreaterThan(10);
    }
  });
  it('every variable has a doc', () => {
    for (const v of b.variables.values()) expect(v.doc.length, v.name).toBeGreaterThan(5);
  });
});

describe('builtin types', () => {
  it('covers every type the parser knows', () => {
    for (const t of BASIC_TYPES) expect(b.types.has(t), t).toBe(true);
  });
  it('knows component info for vectors and matrices', () => {
    expect(b.types.get('vec3')).toMatchObject({ componentType: 'float', components: 3 });
    expect(b.types.get('ivec2')).toMatchObject({ componentType: 'int', components: 2 });
    expect(b.types.get('mat3x2')).toBeDefined();
    expect(b.types.get('dmat4')).toBeDefined();
  });
  it('every type has a doc', () => {
    for (const t of b.types.values()) expect(t.doc.length, t.name).toBeGreaterThan(5);
  });
});

describe('keywords, directives, macros', () => {
  it('documents every qualifier and control keyword the parser knows', () => {
    for (const q of QUALIFIERS) expect(b.keywords.has(q), q).toBe(true);
    for (const c of CONTROL_KEYWORDS) expect(b.keywords.has(c), c).toBe(true);
    for (const w of ['struct', 'layout', 'precision']) expect(b.keywords.has(w), w).toBe(true);
  });
  it('has layout qualifier identifiers', () => {
    for (const n of ['location', 'binding', 'std140', 'local_size_x', 'rgba32f']) expect(b.layoutQualifiers.has(n), n).toBe(true);
  });
  it('has the preprocessor and shader-toy directives', () => {
    for (const n of ['include', 'define', 'ifdef', 'endif', 'version', 'extension', 'iChannel0', 'iChannel3', 'iUniform', 'iKeyboard']) {
      expect(b.directives.has(n), n).toBe(true);
    }
    expect(b.directives.get('iUniform')!.shadertoy).toBe(true);
    expect(b.directives.get('include')!.shadertoy).toBeUndefined();
  });
  it('has predefined macros', () => {
    for (const n of ['__VERSION__', 'GL_ES', '__LINE__']) expect(b.macros.has(n), n).toBe(true);
  });
});

describe('shadertoy environment', () => {
  it('has the exact uniform types', () => {
    const want: Record<string, string> = {
      iResolution: 'vec3', iTime: 'float', iTimeDelta: 'float', iFrameRate: 'float', iFrame: 'int', iChannelTime: 'float[4]',
      iChannelResolution: 'vec3[4]', iMouse: 'vec4', iChannel0: 'sampler2D', iChannel1: 'sampler2D', iChannel2: 'sampler2D',
      iChannel3: 'sampler2D', iDate: 'vec4', iSampleRate: 'float',
    };
    for (const [n, t] of Object.entries(want)) {
      expect(b.variables.get(n)?.type, n).toBe(t);
      expect(b.variables.get(n)!.shadertoy, n).toBe(true);
    }
    expect(b.variables.get('iMouse')!.doc).toMatch(/click/);
  });
  it('has the shader-toy extension uniform iMouseButton and no other runtime-specific uniforms', () => {
    expect(b.variables.get('iMouseButton')).toMatchObject({ type: 'vec4', shadertoy: true });
    const uniforms = [...b.variables.values()].filter((v) => v.shadertoy && !v.name.startsWith('Key_')).map((v) => v.name);
    expect(uniforms.sort()).toEqual(
      ['iResolution', 'iTime', 'iTimeDelta', 'iFrameRate', 'iFrame', 'iChannelTime', 'iChannelResolution', 'iMouse', 'iMouseButton', 'iDate', 'iSampleRate', 'iChannel0', 'iChannel1', 'iChannel2', 'iChannel3'].sort(),
    );
  });
  it('has entry points', () => {
    expect(formatBuiltinFunction(b.functions.get('mainImage')!)).toEqual(['void mainImage(out vec4 fragColor, vec2 fragCoord)']);
    expect(b.functions.get('mainSound')).toBeDefined();
    expect(b.functions.get('mainVR')).toBeDefined();
    expect(b.functions.get('mainImage')!.snippet).toContain('mainImage');
  });
  it('has the keyboard helpers and Key_ constants gated on #iKeyboard', () => {
    for (const n of ['isKeyDown', 'isKeyPressed', 'isKeyToggled', 'isKeyReleased']) {
      const f = b.functions.get(n)!;
      expect(f.requiresDirective).toBe('iKeyboard');
      expect(formatBuiltinFunction(f)).toEqual([`bool ${n}(int key)`]);
    }
    expect(b.variables.get('Key_A')!.value).toBe('65');
    expect(b.variables.get('Key_Z')!.value).toBe('90');
    expect(b.variables.get('Key_D')!.value).toBe('68');
    expect(b.variables.get('Key_Space')!.value).toBe('32');
    expect(b.variables.get('Key_LeftArrow')!.value).toBe('37');
    expect(b.variables.get('Key_5')!.value).toBe('53');
    expect(b.variables.get('Key_F1')!.value).toBe('112');
    for (const v of b.variables.values()) if (v.name.startsWith('Key_')) expect(v.requiresDirective).toBe('iKeyboard');
  });
  it('defines the color3 type', () => {
    expect(b.types.get('color3')!.shadertoy).toBe(true);
  });
});

describe('filters', () => {
  it('hides every shadertoy entry when shadertoy is disabled', () => {
    const off = { shadertoy: false };
    expect(b.get('iTime', off)).toBeUndefined();
    expect(b.get('mainImage', off)).toBeUndefined();
    expect(b.get('color3', off)).toBeUndefined();
    expect(b.allVariables(off).some((v) => v.shadertoy)).toBe(false);
    expect(b.allFunctions(off).some((f) => f.shadertoy)).toBe(false);
    expect(b.allTypes(off).some((t) => t.shadertoy)).toBe(false);
    expect(b.allDirectives(off).some((d) => d.shadertoy)).toBe(false);
    expect(b.get('mix', off)).toBeDefined();
    expect(b.get('iTime')).toBeDefined();
  });
  it('hides keyboard helpers without #iKeyboard', () => {
    expect(b.get('isKeyDown', { directives: new Set() })).toBeUndefined();
    expect(b.get('Key_A', { directives: new Set() })).toBeUndefined();
    expect(b.get('isKeyDown', { directives: new Set(['iKeyboard']) })).toBeDefined();
  });
  it('filters by version', () => {
    expect(b.get('fma', { version: 330 })).toBeUndefined();
    expect(b.get('fma', { version: 450 })).toBeDefined();
  });
  it('adds environment uniforms and defines, and replaces them on the next setEnvironment', () => {
    const env = new Builtins(builtinData);
    env.setEnvironment({
      uniforms: [
        { name: 'iCursorTrail', type: 'vec2[8]', doc: 'Last cursor positions.' },
        { name: 'iMouse', type: 'vec2', doc: 'Overridden.' },
      ],
      defines: { MY_RUNTIME: '', MAX_LIGHTS: '8' },
    });
    expect(env.get('iCursorTrail', { shadertoy: false })).toMatchObject({ kind: 'variable', type: 'vec2[8]', qualifiers: ['uniform'], environment: true });
    expect(env.get('iMouse')).toMatchObject({ type: 'vec2', environment: true });
    expect(env.get('MAX_LIGHTS')).toMatchObject({ kind: 'macro', value: '8', environment: true });
    expect(env.environment.uniforms.map((u) => u.name)).toEqual(['iCursorTrail', 'iMouse']);
    // the shared registry is untouched
    expect(b.get('iCursorTrail')).toBeUndefined();

    env.setEnvironment({ uniforms: [], defines: {} });
    expect(env.get('iCursorTrail')).toBeUndefined();
    expect(env.get('MY_RUNTIME')).toBeUndefined();
    expect(env.get('iMouse')).toMatchObject({ type: 'vec4', shadertoy: true }); // the builtin is back
  });
  it('merges functions split over several data entries', () => {
    const merged = new Builtins({
      ...builtinData,
      functions: [
        { kind: 'function', name: 'f', doc: 'doc', overloads: [{ returnType: 'int', params: [] }] },
        { kind: 'function', name: 'f', doc: 'doc', overloads: [{ returnType: 'float', params: [] }] },
      ],
    });
    expect(merged.functions.get('f')!.overloads.length).toBe(2);
  });
});
