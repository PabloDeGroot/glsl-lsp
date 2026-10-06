// glslLsp.environment.presets ('three.js') and `#include <...>` lines the
// runtime provides.
import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { computeFastDiagnostics } from '../server/src/features/diagnostics';
import { SettingsStore } from '../server/src/settings';
import { makeWorkspace, uri } from './helpers';

// A stock three.js ShaderMaterial vertex shader: no #version, injected names, a chunk include.
const VERTEX = `#include <common>
varying vec2 vUv;
void main() {
    vUv = uv;
    vec3 n = normalMatrix * normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position + n * 0.0, 1.0);
}
`;

const presetEnvironment = (presets: unknown) => {
  const store = new SettingsStore();
  store.update({ environment: { presets } });
  return store.get().environment;
};

describe('three.js preset', () => {
  it('adds the ShaderMaterial names and keeps the user entries first', () => {
    const store = new SettingsStore();
    store.update({ environment: { presets: ['three.js', 'babylon', 'three.js'], uniforms: [{ name: 'position', type: 'vec4', doc: 'mine' }] } });
    const env = store.get().environment;
    expect(env.presets).toEqual(['three.js']);
    expect(env.uniforms[0]).toEqual({ name: 'position', type: 'vec4', doc: 'mine' });
    expect(env.uniforms.filter((u) => u.name === 'position')).toHaveLength(1);
    expect(env.uniforms.map((u) => u.name)).toEqual(expect.arrayContaining(['projectionMatrix', 'modelViewMatrix', 'normalMatrix', 'uv', 'normal']));
  });

  it('ignores a malformed presets value', () => {
    expect(presetEnvironment('three.js')).toEqual({ uniforms: [], defines: {}, presets: [] });
  });

  it('silences undeclared names and chunk includes', () => {
    const env = presetEnvironment(['three.js']);
    const { ws } = makeWorkspace({ 'material.vert': VERTEX }, { environment: env });
    const diags = computeFastDiagnostics(ws, uri('material.vert'), { ignoreAngleIncludes: true });
    expect(diags).toEqual([]);
  });

  it('does not report names the chunks define', () => {
    const src = '#include <common>\n#include <begin_vertex>\nvoid main() {\n    transformed.y += sin(PI * transformed.x);\n    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);\n}\n';
    const { ws } = makeWorkspace({ 'wave.vert': src }, { environment: presetEnvironment(['three.js']) });
    expect(computeFastDiagnostics(ws, uri('wave.vert'), { ignoreAngleIncludes: true })).toEqual([]);
  });

  it('without the preset, a chunk include is a warning that keeps its brackets', () => {
    const { ws } = makeWorkspace({ 'material.vert': VERTEX });
    const diags = computeFastDiagnostics(ws, uri('material.vert'));
    const inc = diags.find((d) => d.code === 'unresolved-include')!;
    expect(inc.severity).toBe(DiagnosticSeverity.Warning);
    expect(inc.message).toBe('Cannot resolve #include <common>.');
    expect(diags.some((d) => d.code === 'undeclared-identifier' && /projectionMatrix/.test(d.message))).toBe(true);
  });

  it('a quoted unresolved include stays an error', () => {
    const { ws } = makeWorkspace({ 'main.glsl': '#include "nope.glsl"\n' });
    const d = computeFastDiagnostics(ws, uri('main.glsl'), { ignoreAngleIncludes: true }).find((x) => x.code === 'unresolved-include')!;
    expect(d.severity).toBe(DiagnosticSeverity.Error);
  });
});
