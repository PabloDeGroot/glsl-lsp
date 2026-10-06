// glslLsp.environment.* (uniforms and defines of a custom shader runtime) and
// the glslLsp.shadertoy.enable modes (auto / on / off).
//
// The example runtime below provides a cursor trail and a light count on top
// of Shadertoy's uniforms, the way a custom player or engine might.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { sanitizeEnvironment, type Environment } from '../server/src/builtins';
import { semanticTokensLegend } from '../server/src/core';
import { computeCompletion } from '../server/src/features/completion';
import { computeFastDiagnostics, computeGlslangDiagnostics, flatten, planValidation, runGlslang } from '../server/src/features/diagnostics';
import { computeHover } from '../server/src/features/hover';
import { computeSemanticTokens } from '../server/src/features/semanticTokens';
import { inferArgType } from '../server/src/features/signatureHelp';
import { cursor, makeWorkspace, posOf, uri, type MakeWorkspaceOptions } from './helpers';

const ENV: Environment = {
  uniforms: [
    { name: 'iCursorTrail', type: 'vec2[8]', doc: 'The last 8 cursor positions in **pixels**, newest first.' },
    { name: 'iGain', type: 'float', doc: 'Master gain.' },
    { name: 'iLightColor', type: 'vec3' },
  ],
  defines: { MY_RUNTIME: '', MAX_LIGHTS: '8' },
};

const TOY = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 p = iCursorTrail[0];
    float g = iGain * float(MAX_LIGHTS);
#ifdef MY_RUNTIME
    g += iCursorTrail[1].x;
#endif
    fragColor = vec4(iLightColor * g, 1.0) + vec4(p.xy, 0.0, 0.0);
}
`;

const PLAIN = `#version 300 es
precision highp float;
out vec4 color;
void main() {
    color = vec4(iLightColor * iGain, float(MAX_LIGHTS));
}
`;

function ws(files: Record<string, string>, options: MakeWorkspaceOptions = {}) {
  return makeWorkspace(files, { environment: ENV, ...options }).ws;
}

function hover(files: Record<string, string>, path: string, needle: string, delta = 0, options: MakeWorkspaceOptions = {}): string {
  const h = computeHover({ workspace: ws(files, options) }, { textDocument: { uri: uri(path) }, position: posOf(files[path], needle, delta) });
  return h ? (h.contents as { value: string }).value : '';
}

function undeclared(files: Record<string, string>, path: string, options: MakeWorkspaceOptions = {}): string[] {
  return computeFastDiagnostics(ws(files, options), uri(path))
    .filter((d) => d.code === 'undeclared-identifier')
    .map((d) => (d.data as { name: string }).name);
}

const GLSLANG = spawnSync('glslangValidator', ['--version']).status === 0;

describe('environment uniforms and defines', () => {
  it('hover shows the signature, the label and the Markdown doc', () => {
    const md = hover({ 'toy.glsl': TOY }, 'toy.glsl', 'iCursorTrail[0]', 2);
    expect(md).toContain('uniform vec2[8] iCursorTrail');
    expect(md).toContain('*Environment uniform*');
    expect(md).toContain('newest first');
    const def = hover({ 'toy.glsl': TOY }, 'toy.glsl', 'MAX_LIGHTS', 2);
    expect(def).toContain('#define MAX_LIGHTS 8');
    expect(def).toContain('*Environment define*');
    expect(hover({ 'toy.glsl': TOY }, 'toy.glsl', 'MY_RUNTIME', 2)).toContain('#define MY_RUNTIME');
  });

  it('completion offers them (in plain GLSL too), marked as environment', () => {
    const { text, position } = cursor('#version 300 es\nvoid main() {\n  float x = iGa|\n}\n');
    const w = ws({ 'a.glsl': text });
    const items = computeCompletion({ workspace: w, snippetSupport: true, autoInclude: true }, { textDocument: { uri: uri('a.glsl') }, position })!.items;
    const gain = items.find((i) => i.label === 'iGain');
    expect(gain).toMatchObject({ detail: 'uniform float iGain', labelDetails: { description: 'environment' } });
    expect(items.find((i) => i.label === 'MAX_LIGHTS')?.labelDetails?.description).toBe('environment');
    expect(items.find((i) => i.label === 'iTime')).toBeUndefined(); // no Shadertoy in a plain file (auto)
  });

  it('types swizzles and array indexing', () => {
    const w = ws({ 'toy.glsl': TOY });
    const model = w.getModel(uri('toy.glsl'))!;
    const at = (expr: string) => {
      const start = TOY.indexOf(expr);
      return inferArgType(w, model, { start, end: start + expr.length });
    };
    expect(at('iCursorTrail[0]')).toBe('vec2');
    expect(at('iCursorTrail[1].x')).toBe('float');
    expect(at('iLightColor')).toBe('vec3');
    expect(at('p.xy')).toBe('vec2');

    const { text, position } = cursor('void mainImage(out vec4 c, in vec2 f) {\n  c.xy = iCursorTrail[2].|\n}\n');
    const w2 = ws({ 'm.glsl': text });
    const items = computeCompletion({ workspace: w2, snippetSupport: true, autoInclude: true }, { textDocument: { uri: uri('m.glsl') }, position })!.items;
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['x', 'y', 'xy']));
    expect(items.map((i) => i.label)).not.toContain('z');
  });

  it('are never reported as undeclared; unconfigured names still are', () => {
    expect(undeclared({ 'toy.glsl': TOY }, 'toy.glsl')).toEqual([]);
    expect(undeclared({ 'p.glsl': PLAIN }, 'p.glsl')).toEqual([]);
    expect(undeclared({ 'toy.glsl': TOY }, 'toy.glsl', { environment: { uniforms: [], defines: {} } })).toEqual(
      expect.arrayContaining(['iCursorTrail', 'iGain', 'MAX_LIGHTS', 'iLightColor']),
    );
  });

  it('get default-library, read-only semantic tokens', () => {
    const w = ws({ 'toy.glsl': TOY });
    const data = computeSemanticTokens(w, w.getModel(uri('toy.glsl'))!).data;
    const lines = TOY.split('\n');
    const toks: { text: string; type: string; mods: string[] }[] = [];
    let line = 0;
    let ch = 0;
    for (let i = 0; i < data.length; i += 5) {
      line += data[i];
      ch = data[i] === 0 ? ch + data[i + 1] : data[i + 1];
      toks.push({
        text: lines[line].substr(ch, data[i + 2]),
        type: semanticTokensLegend.tokenTypes[data[i + 3]],
        mods: semanticTokensLegend.tokenModifiers.filter((_, b) => data[i + 4] & (1 << b)),
      });
    }
    const trail = toks.find((t) => t.text === 'iCursorTrail')!;
    expect(trail.type).toBe('variable');
    expect(trail.mods).toEqual(expect.arrayContaining(['defaultLibrary', 'readonly']));
    expect(toks.find((t) => t.text === 'MAX_LIGHTS')).toMatchObject({ type: 'macro', mods: ['defaultLibrary'] });
  });

  it('are declared in the Shadertoy glslang preamble', () => {
    const w = ws({ 'toy.glsl': TOY });
    const src = flatten(w, uri('toy.glsl'), { shadertoy: true }).source;
    expect(src).toContain('#define MY_RUNTIME\n');
    expect(src).toContain('#define MAX_LIGHTS 8\n');
    expect(src).toContain('uniform highp vec2 iCursorTrail[8];');
    expect(src).toContain('uniform highp float iGain;');
    // after the Shadertoy preamble, before the user's code
    expect(src.indexOf('uniform highp float iGain;')).toBeGreaterThan(src.indexOf('uniform vec3 iResolution;'));
    expect(src.indexOf('uniform highp float iGain;')).toBeLessThan(src.indexOf('void mainImage'));
  });

  it('are declared right after #version for plain GLSL, keeping the line map', () => {
    const w = ws({ 'p.glsl': PLAIN });
    const flat = flatten(w, uri('p.glsl'), { shadertoy: false });
    const lines = flat.source.split('\n');
    expect(lines[0]).toBe('#version 300 es');
    expect(lines.slice(1, 6)).toEqual(['#define MY_RUNTIME', '#define MAX_LIGHTS 8', 'uniform highp vec2 iCursorTrail[8];', 'uniform highp float iGain;', 'uniform highp vec3 iLightColor;']);
    expect(flat.lineMap.slice(1, 6)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    const mainLine = lines.indexOf('void main() {');
    expect(flat.lineMap[mainLine]).toMatchObject({ uri: uri('p.glsl'), line: 3 });
  });

  it('skips names the shader declares or defines itself, and Shadertoy preamble names', () => {
    const own = 'uniform float iGain;\n#define MAX_LIGHTS 4\n' + TOY;
    const w = makeWorkspace({ 'toy.glsl': own }, { environment: { uniforms: [...ENV.uniforms, { name: 'iTime', type: 'float' }], defines: ENV.defines } }).ws;
    const src = flatten(w, uri('toy.glsl'), { shadertoy: true }).source;
    expect(src).not.toContain('uniform highp float iGain;');
    expect(src).not.toContain('#define MAX_LIGHTS 8');
    expect(src).not.toContain('uniform highp float iTime;');
    expect(src).toContain('uniform highp vec2 iCursorTrail[8];');
  });

  it.skipIf(!GLSLANG)('glslangValidator accepts shaders using them (Shadertoy and plain GLSL)', async () => {
    const run = (s: string, st: string) => runGlslang(s, { exe: 'glslangValidator', stage: st });
    for (const [path, text] of [['toy.glsl', TOY], ['p.frag', PLAIN]] as const) {
      const res = await computeGlslangDiagnostics(ws({ [path]: text }), uri(path), { run });
      expect(res.kind, path).toBe('done');
      if (res.kind === 'done') expect([...res.byUri.values()].flat().map((d) => d.message), path).toEqual([]);
    }
    // without the environment the same shader fails to compile
    const bare = await computeGlslangDiagnostics(makeWorkspace({ 'p.frag': PLAIN }).ws, uri('p.frag'), { run });
    expect(bare.kind === 'done' && [...bare.byUri.values()].flat().length).toBeGreaterThan(0);
  });
});

describe('glslLsp.shadertoy.enable', () => {
  const LIB = 'vec3 tint() { return vec3(sin(iTime)); }\n';
  const SHADER = '#include "lib/tint.glsl"\nvoid mainImage(out vec4 c, in vec2 f) { c = vec4(tint(), 1.0); }\n';
  const PLAIN_FILE = '#version 330\nout vec4 o;\nvoid main() { o = vec4(1.0); }\n';
  const DIRECTIVE = '#iChannel0 "file://noise.png"\nvec4 sampleIt(vec2 uv) { return texture(iChannel0, uv); }\n';
  const files = { 'lib/tint.glsl': LIB, 'shader.glsl': SHADER, 'plain.glsl': PLAIN_FILE, 'directive.glsl': DIRECTIVE, 'lone.glsl': 'float f() { return 1.0; }\n' };

  const active = (path: string, options: MakeWorkspaceOptions = {}) => {
    const w = makeWorkspace(files, options).ws;
    return w.shadertoyActive(w.getModel(uri(path)));
  };

  it("'auto' applies to mainImage files, files using shader-toy directives, and their includes", () => {
    expect(active('shader.glsl')).toBe(true);
    expect(active('directive.glsl')).toBe(true);
    expect(active('lib/tint.glsl')).toBe(true); // included by a mainImage shader
    expect(active('plain.glsl')).toBe(false);
    expect(active('lone.glsl')).toBe(false);
  });

  it("'auto' applies everywhere when the client reports the shader-toy extension", () => {
    expect(active('plain.glsl', { shaderToyExtension: true })).toBe(true);
    const w = makeWorkspace(files).ws;
    w.configure({ shaderToyExtension: true });
    expect(w.shadertoyActive(w.getModel(uri('lone.glsl')))).toBe(true);
    w.configure({ shaderToyExtension: false });
    expect(w.shadertoyActive(w.getModel(uri('lone.glsl')))).toBe(false);
  });

  it("'on' and 'off' (and the legacy booleans) override detection", () => {
    expect(active('plain.glsl', { shadertoy: 'on' })).toBe(true);
    expect(active('plain.glsl', { shadertoy: true })).toBe(true);
    expect(active('shader.glsl', { shadertoy: 'off' })).toBe(false);
    expect(active('shader.glsl', { shadertoy: false, shaderToyExtension: true })).toBe(false);
  });

  it('follows edits: adding mainImage to a file turns Shadertoy on for it', () => {
    const w = makeWorkspace(files).ws;
    expect(w.shadertoyActive(w.getModel(uri('lone.glsl')))).toBe(false);
    w.openDocument(uri('lone.glsl'), 'void mainImage(out vec4 c, in vec2 f) { c = vec4(iTime); }\n', 1);
    expect(w.shadertoyActive(w.getModel(uri('lone.glsl')))).toBe(true);
  });

  it('hover and completion only see Shadertoy builtins where it applies', () => {
    const toy = makeWorkspace(files).ws;
    const h = computeHover({ workspace: toy }, { textDocument: { uri: uri('lib/tint.glsl') }, position: posOf(LIB, 'iTime', 1) });
    expect((h?.contents as { value: string }).value).toContain('float iTime');

    const { text, position } = cursor('#version 330\nout vec4 o;\nvoid main() { o = vec4(iTi|); }\n');
    const w = makeWorkspace({ 'plain.glsl': text }).ws;
    const labels = computeCompletion({ workspace: w, snippetSupport: true, autoInclude: true }, { textDocument: { uri: uri('plain.glsl') }, position })!.items.map((i) => i.label);
    expect(labels).not.toContain('iTime');
    const on = makeWorkspace({ 'plain.glsl': text }, { shadertoy: 'on' }).ws;
    const labelsOn = computeCompletion({ workspace: on, snippetSupport: true, autoInclude: true }, { textDocument: { uri: uri('plain.glsl') }, position })!.items.map((i) => i.label);
    expect(labelsOn).toContain('iTime');
  });

  it("'off' reports Shadertoy names as undeclared; 'auto' tolerates them in libraries", () => {
    expect(undeclared(files, 'lib/tint.glsl', { environment: undefined })).toEqual([]);
    const lone = { ...files, 'lone.glsl': 'float f() { return iTime; }\n' };
    expect(undeclared(lone, 'lone.glsl', { environment: undefined })).toEqual([]);
    expect(undeclared(lone, 'lone.glsl', { environment: undefined, shadertoy: 'off' })).toEqual(['iTime']);
  });

  it("'auto' reports Shadertoy names in a plain entry shader (it defines main), not in libraries", () => {
    const entry = { 'e.glsl': '#version 330\nout vec4 o;\nvoid main() { o = vec4(iTime, iMouse.xy, 1.0); }\n' };
    expect(undeclared(entry, 'e.glsl', { environment: undefined })).toEqual(['iTime', 'iMouse']);
    expect(undeclared(entry, 'e.glsl', { environment: undefined, shadertoy: 'on' })).toEqual([]);
    expect(undeclared(entry, 'e.glsl', { environment: undefined, shaderToyExtension: true })).toEqual([]);
  });

  it("'off' validates mainImage files as plain GLSL (no wrapper)", () => {
    const model = makeWorkspace(files).ws.getModel(uri('shader.glsl'))!;
    expect(planValidation(model, true)).toEqual({ stage: 'frag', shadertoy: true });
    expect(planValidation(model, false)).toBeUndefined(); // no main, no #version: nothing to validate on its own
    const both = makeWorkspace({ 'b.glsl': '#version 330\nout vec4 o;\nvoid mainImage(out vec4 c, in vec2 f) { c = vec4(1.0); }\nvoid main() { mainImage(o, gl_FragCoord.xy); }\n' }).ws.getModel(uri('b.glsl'))!;
    expect(planValidation(both, false)).toEqual({ stage: 'frag', shadertoy: false });
  });
});

describe('sanitizeEnvironment', () => {
  it('drops uniforms whose name is not a valid identifier or whose type is not a GLSL type', () => {
    const env = sanitizeEnvironment({
      uniforms: [
        { name: 'uOk', type: 'vec4[16]' },
        { name: 'uX', type: 'notatype' },
        { name: 'float', type: 'vec2' },
        { name: 'goto', type: 'float' },
        { name: 'gl_Foo', type: 'float' },
        { name: 'a__b', type: 'float' },
        { name: 'uVoid', type: 'void' },
        { name: 'uZero', type: 'float[0]' },
        { name: 'BAD NAME', type: 'float' },
        { name: 'uOk', type: 'float' },
      ],
    });
    expect(env.uniforms).toEqual([{ name: 'uOk', type: 'vec4[16]' }]);
  });

  it('drops keyword or reserved define names and strips a trailing backslash from values', () => {
    const env = sanitizeEnvironment({ defines: { OK: '1', BS: 'a \\', ONLY: '\\', if: '1', __X: '1', GL_Y: '1', 'BAD NAME': '1', ML: 'a\nb' } });
    expect(env.defines).toEqual({ OK: '1', BS: 'a', ONLY: '', ML: 'a b' });
  });
});
