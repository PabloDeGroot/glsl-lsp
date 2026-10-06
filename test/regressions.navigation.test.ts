// Regression tests for navigation / signature help / protocol-level defects found in review.
import { describe, expect, it } from 'vitest';
import { getBuiltins } from '../server/src/builtins';
import { invalidIdentifierReason, isGlslPath, MemoryFileSystem, Workspace } from '../server/src/core';
import { computeDocumentColors } from '../server/src/features/colors';
import { computeDefinition, computeDocumentLinks, computePrepareRename, computeRename, isReadOnlyForRename } from '../server/src/features/navigation';
import { computeSignatureHelp } from '../server/src/features/signatureHelp';
import { cursor, makeWorkspace, parseText, posOf, uri } from './helpers';

const U = uri('main.glsl');

describe('rename', () => {
  const text = 'float f(float x){ float y = x; return y; }\n';
  const { ws } = makeWorkspace({ 'main.glsl': text });

  it('rejects reserved words, gl_ names and double underscores', () => {
    for (const bad of ['class', 'template', 'union', 'goto', 'input', 'gl_Pos', 'a__b', 'float', '1x', 'texture']) {
      expect(computeRename(ws, U, posOf(text, 'y =', 0), bad), bad).toBeNull();
    }
    expect(invalidIdentifierReason('goto')).toMatch(/reserved/);
    expect(computeRename(ws, U, posOf(text, 'y =', 0), 'yy')).not.toBeNull();
  });

  it('refuses symbols declared in LYGIA / read-only folders, with a reason', () => {
    const files = {
      'lygia/math/saturate.glsl': 'float sat(float x) { return clamp(x, 0.0, 1.0); }\n',
      'main.glsl': '#include "lygia/math/saturate.glsl"\nvoid main(){ float a = sat(2.0); }\n',
    };
    const w = makeWorkspace(files).ws;
    const prep = computePrepareRename(w, U, posOf(files['main.glsl'], 'sat(2'));
    expect(prep).toEqual({ error: expect.stringMatching(/lygia\/math\/saturate\.glsl.*read-only/) });
    expect(computeRename(w, U, posOf(files['main.glsl'], 'sat(2'), 'sat2')).toBeNull();
    // A custom list.
    expect(computePrepareRename(w, U, posOf(files['main.glsl'], 'sat(2'), { readOnlyPaths: [] })).toHaveProperty('placeholder', 'sat');
    expect(isReadOnlyForRename(w, uri('vendor/x/y.glsl'), ['vendor/x'])).toBe(true);
    expect(isReadOnlyForRename(w, 'file:///elsewhere/y.glsl')).toBe(true);
  });

  it('refuses builtins with a reason', () => {
    const t = 'void main(){ float a = sin(1.0); }\n';
    const w = makeWorkspace({ 'main.glsl': t }).ws;
    expect(computePrepareRename(w, U, posOf(t, 'sin'))).toEqual({ error: expect.stringMatching(/builtin/) });
  });
});

describe('definition', () => {
  it('picks the overload matching the argument types', () => {
    const t = 'float n(vec2 p){ return p.x; }\nfloat n(vec3 p){ return p.x; }\nvoid main(){ vec3 q = vec3(1.0); float a = n(q); float b = n(vec2(1.0)); }\n';
    const { ws } = makeWorkspace({ 'main.glsl': t });
    expect(computeDefinition(ws, U, posOf(t, 'n(q)')).map((l) => l.range.start.line)).toEqual([1]);
    expect(computeDefinition(ws, U, posOf(t, 'n(vec2(1')).map((l) => l.range.start.line)).toEqual([0]);
  });
});

describe('signature help', () => {
  const sig = (src: string) => {
    const { text, position } = cursor(src);
    const { ws } = makeWorkspace({ 'main.glsl': text });
    const r = computeSignatureHelp({ workspace: ws }, { textDocument: { uri: U }, position });
    return r ? r.signatures[r.activeSignature ?? 0].label : null;
  };

  it('survives `;` and braces inside comments of an unclosed call', () => {
    for (const c of ['// half; full', '// a { b', '/* x; */']) {
      expect(sig(`float f(float a, vec2 b){return a;}\nvoid main(){ float x = f(1.0, ${c}\n   |`), c).toBe('float f(float a, vec2 b)');
    }
  });

  it('texture(iChannel0, |) selects a 2D overload', () => {
    expect(sig('void mainImage(out vec4 o, in vec2 f){ vec2 uv; float n = texture(iChannel0, |')).toMatch(/gsampler2D sampler, vec2/);
  });
});

describe('document links', () => {
  it('a cubemap pattern links to the first existing face', () => {
    const fs = new MemoryFileSystem({ 'file:///ws/main.glsl': '#iChannel0 "file://textures/cube/sky_{}.png"\n#iChannel1 "file://textures/none_{}.png"\nvoid mainImage(out vec4 c, in vec2 f){}\n', 'file:///ws/textures/cube/sky_nx.png': 'x' });
    const ws = new Workspace({ fs, builtins: getBuiltins(), roots: ['file:///ws'] });
    ws.indexWorkspaceSync();
    const links = computeDocumentLinks(ws, U);
    expect(links.map((l) => l.target)).toEqual(['file:///ws/textures/cube/sky_nx.png']);
  });
});

describe('colors', () => {
  it('does not put swatches on directions and positions', () => {
    const src = [
      'void mainImage(out vec4 c, in vec2 f) {',
      '  vec3 n = vec3(0.0, 1.0, 0.0);',
      '  vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));',
      '  vec3 sunPos = vec3(0.0, 1.0, 0.0);',
      '  vec3 lightPos = vec3(1.0, 1.0, 0.0);',
      '  float diffuse = max(dot(n, vec3(0.0, 1.0, 0.0)), 0.0);',
      '  float shadeAmt = dot(n, vec3(0.577, 0.577, 0.577));',
      '  vec3 lightCol = vec3(1.0, 0.9, 0.8);',
      '  vec3 skyTint = vec3(0.2, 0.4, 0.8);',
      '}',
      '#define LIGHT_DIR vec3(0,1,0)',
      '#define SKY_COLOR vec3(0.1, 0.2, 0.3)',
    ].join('\n');
    const lines = computeDocumentColors(parseText(src), 'heuristic').map((c) => c.range.start.line);
    expect(lines).toEqual([7, 8, 11]);
  });
});

describe('file extensions', () => {
  it('.fs/.vs (F#, ...) are not GLSL', () => {
    expect(isGlslPath('Program.fs')).toBe(false);
    expect(isGlslPath('shader.vs')).toBe(false);
    expect(isGlslPath('shader.frag')).toBe(true);
  });
});
