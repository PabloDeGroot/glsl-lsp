import { describe, expect, it } from 'vitest';
import { getBuiltins } from '../server/src/builtins';
import { MemoryFileSystem, Workspace, type FunctionSymbol, type ModelChangeEvent } from '../server/src/core';
import { makeWorkspace, posOf, uri } from './helpers';

const MAIN = `#include "lib/common.glsl"
#iUniform float u_speed = 1.0 in { 0.0, 4.0 }

struct Hit { float d; vec3 n; };

Hit scene(vec3 p) { Hit h; h.d = length(p); return h; }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = uvCentered(fragCoord, iResolution.xy);
    float t = iTime * u_speed;
    Hit h = scene(vec3(uv, t));
    fragColor = vec4(vec3(h.d), 1.0) + vec4(uv.xy, 0.0, 0.0);
    float n = gnoise(t);
}
`;

const COMMON = `#include "../lygia/math/const.glsl"

// Centered and aspect corrected.
vec2 uvCentered(vec2 fragCoord, vec2 res) { return (fragCoord * 2.0 - res) / res.y; }
vec2 uvCentered(vec2 fragCoord) { return fragCoord; }
`;

const files = {
  'main.glsl': MAIN,
  'lib/common.glsl': COMMON,
  'lygia/math/const.glsl': '/*\ndescription: some useful math constants\n*/\n#ifndef PI\n#define PI 3.14159\n#endif\n',
  'lygia/generative/gnoise.glsl': '/*\ndescription: Gradient Noise\nuse: gnoise(<float> x)\n*/\n#ifndef FNC_GNOISE\n#define FNC_GNOISE\nfloat gnoise(float x) { return x; }\n#endif\n',
  'lib/uses_parent.glsl': 'float k() { return uvCentered(vec2(0.0)).x; }\n',
};

describe('workspace index', () => {
  const { ws } = makeWorkspace(files);

  it('indexes every file and builds a global table', () => {
    expect(ws.size).toBe(5);
    expect(ws.findDeclaringFiles('gnoise')).toEqual([uri('lygia/generative/gnoise.glsl')]);
    expect(ws.findDeclaringFiles('FNC_GNOISE')).toEqual([]); // guard macros are not offered
    expect(ws.lookupGlobal('uvCentered')).toHaveLength(2);
  });

  it('lists visible symbols: locals, file, includes', () => {
    const vis = ws.visibleSymbols(uri('main.glsl'), posOf(MAIN, 'Hit h = scene'));
    expect(vis.locals.map((s) => s.name)).toEqual(['t', 'uv', 'fragCoord', 'fragColor']);
    const globals = vis.globals.map((s) => s.name);
    expect(globals).toEqual(expect.arrayContaining(['Hit', 'scene', 'mainImage', 'u_speed', 'uvCentered', 'PI']));
    expect(globals).not.toContain('gnoise');
    expect(vis.files).toEqual([uri('main.glsl'), uri('lib/common.glsl'), uri('lygia/math/const.glsl')]);
  });

  it('resolves locals and parameters', () => {
    const r = ws.resolveSymbolAt(uri('main.glsl'), posOf(MAIN, 'uv, t))', 1));
    expect(r).toMatchObject({ kind: 'symbol', primary: { kind: 'variable', name: 'uv', storage: 'local' } });
    const p = ws.resolveSymbolAt(uri('main.glsl'), posOf(MAIN, 'fragCoord, iResolution'));
    expect(p).toMatchObject({ kind: 'symbol', primary: { kind: 'parameter', name: 'fragCoord' } });
  });

  it('resolves functions from includes and picks the overload by argument count', () => {
    const r = ws.resolveSymbolAt(uri('main.glsl'), posOf(MAIN, 'uvCentered(fragCoord'));
    expect(r?.kind).toBe('symbol');
    if (r?.kind !== 'symbol') return;
    expect(r.symbols).toHaveLength(2);
    expect((r.primary as FunctionSymbol).params).toHaveLength(2);
    expect(r.primary.uri).toBe(uri('lib/common.glsl'));
    expect(r.fromWorkspace).toBeUndefined();
  });

  it('resolves #iUniform, builtins and shadertoy uniforms', () => {
    expect(ws.resolveSymbolAt(uri('main.glsl'), posOf(MAIN, 'u_speed;'))).toMatchObject({
      kind: 'symbol',
      primary: { origin: 'iUniform' },
    });
    expect(ws.resolveSymbolAt(uri('main.glsl'), posOf(MAIN, 'iTime'))).toMatchObject({ kind: 'builtin', name: 'iTime' });
    expect(ws.resolveSymbolAt(uri('main.glsl'), posOf(MAIN, 'length(p)'))).toMatchObject({ kind: 'builtin', name: 'length' });
    expect(ws.resolveSymbolAt(uri('main.glsl'), posOf(MAIN, 'vec4(vec3'))).toMatchObject({ kind: 'builtin', name: 'vec4' });
  });

  it('resolves struct members and swizzles through types', () => {
    expect(ws.resolveSymbolAt(uri('main.glsl'), posOf(MAIN, 'h.d)', 2))).toMatchObject({
      kind: 'symbol',
      primary: { kind: 'field', name: 'd', parent: 'Hit' },
    });
    expect(ws.resolveSymbolAt(uri('main.glsl'), posOf(MAIN, 'uv.xy', 3))).toMatchObject({
      kind: 'swizzle',
      receiverType: 'vec2',
      resultType: 'vec2',
    });
    expect(ws.resolveSymbolAt(uri('main.glsl'), posOf(MAIN, 'iResolution.xy', 12))).toMatchObject({
      kind: 'swizzle',
      receiverType: 'vec3',
      resultType: 'vec2',
    });
  });

  it('falls back to the workspace for symbols not reachable through includes', () => {
    const r = ws.resolveSymbolAt(uri('main.glsl'), posOf(MAIN, 'gnoise'));
    expect(r).toMatchObject({ kind: 'symbol', fromWorkspace: true });
    const k = ws.resolveSymbolAt(uri('lib/uses_parent.glsl'), { line: 0, character: 22 });
    expect(k).toMatchObject({ kind: 'symbol', name: 'uvCentered', fromWorkspace: true });
  });

  it('resolves #include paths', () => {
    expect(ws.resolveSymbolAt(uri('main.glsl'), { line: 0, character: 12 })).toMatchObject({
      kind: 'include',
      targetUri: uri('lib/common.glsl'),
    });
  });

  it('finds references across files', () => {
    const refs = ws.findReferences(uri('lib/common.glsl'), posOf(COMMON, 'uvCentered'), true);
    const where = refs.map((r) => `${r.uri.slice(ROOT_LEN)}:${r.range.start.line}${r.isDeclaration ? 'D' : ''}`).sort();
    expect(where).toEqual(['lib/common.glsl:3D', 'lib/common.glsl:4D', 'lib/uses_parent.glsl:0', 'main.glsl:8']);
    const locals = ws.findReferences(uri('main.glsl'), posOf(MAIN, 'uv ='), false);
    expect(locals.map((r) => r.range.start.line)).toEqual([10, 11]);
  });

  it('notifies listeners with affected includers', () => {
    const events: ModelChangeEvent[] = [];
    const sub = ws.onDidChangeModel((e) => events.push(e));
    ws.updateDocument(uri('lygia/math/const.glsl'), '#define PI 3.0\n', 1);
    sub.dispose();
    expect(events).toHaveLength(1);
    expect(events[0].affected).toEqual(expect.arrayContaining([uri('lygia/math/const.glsl'), uri('lib/common.glsl'), uri('main.glsl')]));
  });
});

const ROOT_LEN = uri('').length;

describe('index.exclude', () => {
  it('accepts folder names and relative paths', () => {
    const files: Record<string, string> = {
      'main.glsl': 'void main() {}\n',
      'tools/glsl-lsp/test/fixtures/a.glsl': 'float a() { return 1.0; }\n',
      'tools/glsl-lsp/src/b.glsl': 'float b() { return 1.0; }\n',
      'vendor/c.glsl': 'float c() { return 1.0; }\n',
      'vendor/keep/d.glsl': 'float d() { return 1.0; }\n',
    };
    const fs = new MemoryFileSystem(Object.fromEntries(Object.entries(files).map(([p, t]) => [uri(p), t])));
    const exclude = ['test/fixtures', 'vendor/c-not-here', './vendor/keep/'];
    const ws = new Workspace({ fs, builtins: getBuiltins(), roots: [uri('')], exclude });
    ws.indexWorkspaceSync();
    const names = [...ws.allGlobalSymbols()].map((s) => s.name).sort();
    expect(names).toEqual(['b', 'c', 'main']);
  });
});
