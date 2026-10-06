// Vulkan GLSL: glslang target detection (glslLsp.diagnostics.glslang.targetEnv),
// the environment preamble under Vulkan rules and the Vulkan-only stages.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeGlslangDiagnostics, flatten, runGlslang } from '../server/src/features/diagnostics';
import { resolveTargetEnv, stageForUri, usesVulkanGlsl } from '../server/src/features/diagnostics/flatten';
import { makeWorkspace, uri, type MakeWorkspaceOptions } from './helpers';

const VULKAN_FRAG = `#version 450
layout(set = 0, binding = 0) uniform sampler2D albedo;
layout(push_constant) uniform Push { float exposure; } pc;
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
    outColor = texture(albedo, vUv) * pc.exposure;
}
`;

const GL_FRAG = `#version 330 core
uniform float u_time;
out vec4 fragColor;
void main() {
    fragColor = vec4(sin(u_time));
}
`;

describe('Vulkan GLSL detection', () => {
  it('recognizes Vulkan-only syntax', () => {
    expect(usesVulkanGlsl('layout(set = 1, binding = 2) uniform sampler2D t;')).toBe(true);
    expect(usesVulkanGlsl('layout(push_constant) uniform P { mat4 m; } p;')).toBe(true);
    expect(usesVulkanGlsl('layout(constant_id = 0) const int N = 4;')).toBe(true);
    expect(usesVulkanGlsl('layout(input_attachment_index = 0, set = 0, binding = 1) uniform subpassInput s;')).toBe(true);
    expect(usesVulkanGlsl('layout(binding = 0) uniform texture2D tex;')).toBe(true);
    expect(usesVulkanGlsl('uniform sampler samp;')).toBe(true);
    expect(usesVulkanGlsl('int i = gl_VertexIndex;')).toBe(true);
    expect(usesVulkanGlsl('#extension GL_EXT_ray_tracing : require')).toBe(true);
  });

  it('does not mistake OpenGL GLSL or comments for Vulkan', () => {
    expect(usesVulkanGlsl(GL_FRAG)).toBe(false);
    expect(usesVulkanGlsl('layout(std140, binding = 0) uniform Block { vec4 a; };\nvec4 c = texture2D(tex, uv);')).toBe(false);
    expect(usesVulkanGlsl('// layout(push_constant) is Vulkan only\n/* gl_VertexIndex */\nint i = gl_VertexID;')).toBe(false);
  });

  it('resolves the target per setting', () => {
    expect(resolveTargetEnv('auto', 'frag', GL_FRAG)).toBeUndefined();
    expect(resolveTargetEnv('auto', 'frag', VULKAN_FRAG)).toBe('vulkan1.2');
    expect(resolveTargetEnv('auto', 'rgen', GL_FRAG)).toBe('vulkan1.2');
    expect(resolveTargetEnv('opengl', 'frag', VULKAN_FRAG)).toBeUndefined();
    expect(resolveTargetEnv('vulkan1.3', 'frag', GL_FRAG)).toBe('vulkan1.3');
  });

  it('takes Vulkan-only stages and the new extensions from the file name', () => {
    expect(stageForUri('file:///a/hit.rchit')).toBe('rchit');
    expect(stageForUri('file:///a/gen.rgen')).toBe('rgen');
    expect(stageForUri('file:///a/m.mesh')).toBe('mesh');
    expect(stageForUri('file:///a/t.task')).toBe('task');
    // Inside a longer name a Vulkan-only stage is just a word: skinned.mesh.glsl is not a mesh shader.
    expect(stageForUri('file:///a/skinned.mesh.glsl')).toBe('frag');
    expect(stageForUri('file:///a/water.vert.glsl')).toBe('vert');
    expect(stageForUri('file:///a/basic.vsh')).toBe('vert');
    expect(stageForUri('file:///a/basic.fshader')).toBe('frag');
    expect(stageForUri('file:///a/basic.glslg')).toBe('geom');
  });
});

describe('flattening for Vulkan', () => {
  const env = {
    uniforms: [
      { name: 'u_time', type: 'float' },
      { name: 'u_lights', type: 'vec4[4]' },
      { name: 'u_noise', type: 'sampler2D' },
    ],
    defines: { MAX_LIGHTS: '4' },
  };

  it('puts environment uniforms in a block with explicit bindings', () => {
    const { ws } = makeWorkspace({ 'v.frag': VULKAN_FRAG }, { environment: env });
    const flat = flatten(ws, uri('v.frag'), { shadertoy: false });
    expect(flat.targetEnv).toBe('vulkan1.2');
    const lines = flat.source.split('\n');
    expect(lines[0]).toBe('#version 450');
    expect(lines).toContain('#define MAX_LIGHTS 4');
    expect(lines).toContain('layout(set = 7, binding = 1) uniform sampler2D u_noise;');
    expect(lines).toContain('layout(set = 7, binding = 0) uniform GlslLspEnvironment { float u_time; vec4 u_lights[4]; };');
  });

  it('keeps precision qualifiers for Vulkan GLSL ES', () => {
    const src = '#version 310 es\nlayout(set = 0, binding = 0) uniform sampler2D t;\nlayout(location = 0) out highp vec4 o;\nvoid main() { o = texture(t, vec2(0)); }\n';
    const { ws } = makeWorkspace({ 'es.frag': src }, { environment: env });
    const flat = flatten(ws, uri('es.frag'), { shadertoy: false });
    expect(flat.source).toContain('uniform GlslLspEnvironment { highp float u_time; highp vec4 u_lights[4]; };');
    expect(flat.source).toContain('uniform highp sampler2D u_noise;');
  });

  it('ignores Vulkan constructs inside #if branches', () => {
    const src = [
      '#version 450',
      '#ifdef USE_VULKAN',
      'layout(set = 0, binding = 0) uniform UBO { float time; };',
      '#else',
      'uniform float time;',
      '#endif',
      'out vec4 o;',
      'void main() { o = vec4(time); }',
      '',
    ].join('\n');
    const { ws } = makeWorkspace({ 'x.frag': src });
    expect(flatten(ws, uri('x.frag'), { shadertoy: false }).targetEnv).toBeUndefined();
  });

  it('does not redeclare a uniform the shader has in a nameless block', () => {
    const src = VULKAN_FRAG.replace('layout(push_constant)', 'layout(set = 0, binding = 1) uniform Globals { float u_time; };\nlayout(push_constant)');
    const { ws } = makeWorkspace({ 'v.frag': src }, { environment: env });
    expect(flatten(ws, uri('v.frag'), { shadertoy: false }).source).not.toContain('float u_time; vec4');
  });

  it('keeps loose uniforms for OpenGL and Shadertoy units', () => {
    const { ws } = makeWorkspace({ 'g.frag': GL_FRAG, 'toy.glsl': 'void mainImage(out vec4 c, in vec2 p) { c = vec4(gl_VertexIndex); }' }, { environment: env });
    const gl = flatten(ws, uri('g.frag'), { shadertoy: false });
    expect(gl.targetEnv).toBeUndefined();
    expect(gl.source).toContain('uniform sampler2D u_noise;');
    // The Shadertoy wrapper is WebGL 2: never Vulkan, whatever the body says.
    expect(flatten(ws, uri('toy.glsl'), { shadertoy: true }).targetEnv).toBeUndefined();
    expect(flatten(ws, uri('g.frag'), { shadertoy: false, targetEnv: 'vulkan1.1' }).targetEnv).toBe('vulkan1.1');
  });

  it('passes the target to the runner', async () => {
    const { ws } = makeWorkspace({ 'v.frag': VULKAN_FRAG, 'g.frag': GL_FRAG });
    const seen: (string | undefined)[] = [];
    const run = async (_s: string, _st: string, _signal?: AbortSignal, targetEnv?: string) => {
      seen.push(targetEnv);
      return { ok: true as const, output: '', exitCode: 0 };
    };
    await computeGlslangDiagnostics(ws, uri('v.frag'), { run });
    await computeGlslangDiagnostics(ws, uri('g.frag'), { run });
    await computeGlslangDiagnostics(ws, uri('v.frag'), { run, targetEnv: 'opengl' });
    expect(seen).toEqual(['vulkan1.2', undefined, undefined]);
  });
});

const GLSLANG = spawnSync('glslangValidator', ['--version']).status === 0;

describe.skipIf(!GLSLANG)('glslangValidator with Vulkan GLSL', () => {
  const run = (s: string, st: string, signal?: AbortSignal, targetEnv?: string) => runGlslang(s, { exe: 'glslangValidator', stage: st, signal, targetEnv });
  const errors = async (files: Record<string, string>, file: string, environment?: MakeWorkspaceOptions['environment']) => {
    const { ws } = makeWorkspace(files, { environment });
    const res = await computeGlslangDiagnostics(ws, uri(file), { run });
    expect(res.kind).toBe('done');
    return res.kind === 'done' ? [...res.byUri.values()].flat().map((d) => d.message) : [];
  };

  it('accepts a valid Vulkan shader and writes no SPIR-V', async () => {
    expect(await errors({ 'v.frag': VULKAN_FRAG }, 'v.frag')).toEqual([]);
    expect(existsSync(join(process.cwd(), 'frag.spv'))).toBe(false);
  });

  it('accepts environment uniforms in a Vulkan shader', async () => {
    const src = VULKAN_FRAG.replace('* pc.exposure', '* pc.exposure * u_time * u_lights[0].x + texture(u_noise, vUv)');
    const env = { uniforms: [{ name: 'u_time', type: 'float' }, { name: 'u_lights', type: 'vec4[4]' }, { name: 'u_noise', type: 'sampler2D' }] };
    expect(await errors({ 'v.frag': src }, 'v.frag', env)).toEqual([]);
  });

  it('still reports real Vulkan errors', async () => {
    const src = VULKAN_FRAG.replace('pc.exposure;', 'pc.missing;');
    expect((await errors({ 'v.frag': src }, 'v.frag')).join('\n')).toMatch(/missing/);
  });

  it('keeps OpenGL rules for OpenGL shaders', async () => {
    expect(await errors({ 'g.frag': GL_FRAG }, 'g.frag')).toEqual([]);
  });
});
