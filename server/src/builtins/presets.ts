// Environment presets (glslLsp.environment.presets): the names a framework
// injects into every shader, added to glslLsp.environment.uniforms so users do
// not have to list them. Entries the user declares in uniforms win.

import type { EnvironmentUniform } from './index';

export type EnvironmentPreset = 'three.js';

export const ENVIRONMENT_PRESETS: Readonly<Record<EnvironmentPreset, readonly EnvironmentUniform[]>> = {
  // The unconditional part of the prefix three.js puts before a ShaderMaterial's
  // vertex shader (the fragment prefix is a subset). RawShaderMaterial adds none.
  'three.js': [
    { name: 'modelMatrix', type: 'mat4', doc: 'three.js: object to world space.' },
    { name: 'modelViewMatrix', type: 'mat4', doc: 'three.js: object to camera space (`viewMatrix * modelMatrix`).' },
    { name: 'projectionMatrix', type: 'mat4', doc: "three.js: the camera's projection." },
    { name: 'viewMatrix', type: 'mat4', doc: 'three.js: world to camera space.' },
    { name: 'normalMatrix', type: 'mat3', doc: 'three.js: transforms object-space normals to camera space.' },
    { name: 'cameraPosition', type: 'vec3', doc: 'three.js: camera position in world space.' },
    { name: 'isOrthographic', type: 'bool', doc: 'three.js: the camera is orthographic.' },
    { name: 'position', type: 'vec3', doc: 'three.js vertex attribute: object-space position.' },
    { name: 'normal', type: 'vec3', doc: 'three.js vertex attribute: object-space normal.' },
    { name: 'uv', type: 'vec2', doc: 'three.js vertex attribute: texture coordinates.' },
  ],
};

export function isEnvironmentPreset(value: unknown): value is EnvironmentPreset {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ENVIRONMENT_PRESETS, value);
}
