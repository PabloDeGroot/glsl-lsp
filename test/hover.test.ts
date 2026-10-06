import { describe, expect, it } from 'vitest';
import { computeHover } from '../server/src/features/hover';
import { makeWorkspace, posOf, uri } from './helpers';

const MAIN = `#include "lib/common.glsl"
// Overall speed.
#iUniform float u_speed = 1.0 in { 0.0, 4.0 }
#iUniform color3 u_tint = color3(1.0, 0.5, 0.2)

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = uvCentered(fragCoord, iResolution.xy);
    float n = gnoise(uv.x * u_speed) + PI;
    fragColor = vec4(mix(u_tint, vec3(n), 0.5), 1.0);
}
`;

const files = {
  'main.glsl': MAIN,
  'lib/common.glsl':
    '// lib/common.glsl - helpers.\n\n#include "../lygia/math/const.glsl"\n\n// Centered and aspect corrected: y spans [-1, 1].\n// This is the space you want.\nvec2 uvCentered(vec2 fragCoord, vec2 res) { return (fragCoord * 2.0 - res) / res.y; }\n',
  'lygia/math/const.glsl': '/*\ncontributors: Patricio Gonzalez Vivo\ndescription: some useful math constants\nlicense: MIT\n*/\n#ifndef PI\n#define PI 3.1415926535897932384626433832795\n#endif\n',
  'lygia/generative/gnoise.glsl':
    '/*\ncontributors: Patricio Gonzalez Vivo\ndescription: Gradient Noise\nuse: gnoise(<float> x)\nlicense: secret-license-text\n*/\n#ifndef FNC_GNOISE\n#define FNC_GNOISE\nfloat gnoise(float x) { return x; }\nfloat gnoise(vec2 st) { return st.x; }\n#endif\n',
};

function hoverAt(needle: string, delta = 0): string {
  const { ws } = makeWorkspace(files);
  const h = computeHover({ workspace: ws }, { textDocument: { uri: uri('main.glsl') }, position: posOf(MAIN, needle, delta) });
  if (!h) return '';
  return (h.contents as { value: string }).value;
}

describe('hover', () => {
  it('shows a user function with its // docs and where it is defined', () => {
    const md = hoverAt('uvCentered(');
    expect(md).toContain('```glsl\nvec2 uvCentered(vec2 fragCoord, vec2 res)\n```');
    expect(md).toContain('Centered and aspect corrected: y spans \\[-1, 1\\].'.replace('\\[', '[').replace('\\]', ']'));
    expect(md).toContain('Defined in [lib/common.glsl:7]');
  });

  it('shows LYGIA functions with every overload and the YAML doc, and the missing include', () => {
    const md = hoverAt('gnoise(');
    expect(md).toContain('float gnoise(float x)\nfloat gnoise(vec2 st)');
    expect(md).toContain('Gradient Noise');
    expect(md).toContain('**Usage**');
    expect(md).not.toContain('secret-license-text');
    expect(md).toContain('not included here (`#include "lygia/generative/gnoise.glsl"`)');
  });

  it('shows macros with their file doc', () => {
    const md = hoverAt('PI;');
    expect(md).toContain('#define PI 3.14159');
    expect(md).toContain('some useful math constants');
  });

  it('shows parameters and locals', () => {
    expect(hoverAt('fragCoord, iRes')).toContain('```glsl\nin vec2 fragCoord\n```\n\n*parameter of `mainImage`*');
    expect(hoverAt('uv.x')).toContain('*local variable*');
  });

  it('shows #iUniform details', () => {
    const md = hoverAt('u_speed)');
    expect(md).toContain('#iUniform float u_speed = 1.0 in { 0.0, 4.0 }');
    expect(md).toContain('range 0.0 … 4.0');
    expect(md).toContain('Overall speed.');
    expect(hoverAt('u_tint, vec3')).toContain('GLSL type `vec3`');
  });

  it('shows builtins and shadertoy uniforms', () => {
    const mix = hoverAt('mix(');
    expect(mix).toContain('genType mix(genType x, genType y, genType a)');
    expect(mix).toContain('[Reference](');
    expect(hoverAt('iResolution')).toContain('vec3 iResolution');
  });

  it('shows the target file for #include paths', () => {
    const md = hoverAt('lib/common', 2);
    expect(md).toContain('**lib/common.glsl**');
    expect(md).toContain('uvCentered');
  });

  it('returns null on whitespace', () => {
    expect(hoverAt('    vec2 uv', 1)).toBe('');
  });
});
