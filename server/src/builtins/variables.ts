// Builtin GLSL variables (gl_*) and implementation-dependent constants.

import { KHRONOS } from './define';
import type { BuiltinVariable, ShaderStage } from './types';

function v(name: string, type: string, qualifiers: string[], stages: ShaderStage[] | undefined, doc: string, extra: Partial<BuiltinVariable> = {}): BuiltinVariable {
  const out: BuiltinVariable = { kind: 'variable', name, type, doc, qualifiers, ...extra };
  if (stages) out.stages = stages;
  // Khronos has a page for most gl_* variables; the page name is the variable name unless overridden.
  out.docUrl = extra.docUrl === '' ? undefined : KHRONOS + (extra.docUrl ?? `${name}.xhtml`);
  if (!out.docUrl) delete out.docUrl;
  return out;
}

const VS: ShaderStage[] = ['vertex'];
const FS: ShaderStage[] = ['fragment'];
const CS: ShaderStage[] = ['compute'];
const GS: ShaderStage[] = ['geometry'];

const DEPRECATED_FRAG = 'Compatibility / GLSL ES 1.00 only; declare your own `out vec4` instead.';

export const builtinVariables: BuiltinVariable[] = [
  // ---- vertex
  v('gl_VertexID', 'int', ['in'], VS, 'Index of the current vertex in the draw call (for indexed draws, the index value). Not available in Vulkan GLSL; see `gl_VertexIndex`.', { minVersion: 130 }),
  v('gl_InstanceID', 'int', ['in'], VS, 'Index of the current instance in an instanced draw call. Always 0 for non-instanced draws.', { minVersion: 140 }),
  v('gl_VertexIndex', 'int', ['in'], VS, 'Vulkan GLSL: index of the current vertex, including the base vertex offset.', { docUrl: 'gl_VertexID.xhtml' }),
  v('gl_InstanceIndex', 'int', ['in'], VS, 'Vulkan GLSL: index of the current instance, including the base instance offset.', { docUrl: 'gl_InstanceID.xhtml' }),
  v('gl_DrawID', 'int', ['in'], VS, 'Index of the current draw within a multi-draw command.', { minVersion: 460 }),
  v('gl_BaseVertex', 'int', ['in'], VS, 'The base vertex offset of the current draw command.', { minVersion: 460 }),
  v('gl_BaseInstance', 'int', ['in'], VS, 'The base instance offset of the current draw command.', { minVersion: 460 }),
  v('gl_Position', 'vec4', ['out'], ['vertex', 'geometry', 'tessEval'], 'Clip-space position of the current vertex. Must be written by the last vertex-processing stage.'),
  v('gl_PointSize', 'float', ['out'], ['vertex', 'geometry', 'tessEval'], 'Size in pixels of the point being rasterized when drawing `GL_POINTS`.'),
  v('gl_ClipDistance', 'float[]', ['out'], ['vertex', 'geometry', 'tessEval'], 'Array of distances to user clip planes. Geometry is clipped where a distance is negative.', { minVersion: 130 }),
  v('gl_CullDistance', 'float[]', ['out'], ['vertex', 'geometry', 'tessEval'], 'Array of distances used to cull primitives whose vertices all have a negative distance.', { minVersion: 450 }),

  // ---- fragment
  v('gl_FragCoord', 'vec4', ['in'], FS, 'Window-relative coordinates of the current fragment. `xy` is the pixel centre (`0.5, 0.5` for the bottom-left pixel), `z` is the depth, `w` is `1 / w_clip`.'),
  v('gl_FrontFacing', 'bool', ['in'], FS, 'True if the fragment belongs to a front-facing primitive.'),
  v('gl_PointCoord', 'vec2', ['in'], FS, 'Position within a point sprite, from `(0, 0)` at the top-left to `(1, 1)` at the bottom-right.'),
  v('gl_FragDepth', 'float', ['out'], FS, 'Depth value written for the fragment, in `[0, 1]`. If any invocation writes it, every path should.'),
  v('gl_FragColor', 'vec4', ['out'], FS, 'GLSL ES 1.00 fragment colour output.', { deprecated: DEPRECATED_FRAG, docUrl: 'gl_FragColor.xhtml' }),
  v('gl_FragData', 'vec4[]', ['out'], FS, 'GLSL ES 1.00 array of fragment colour outputs, one per draw buffer.', { deprecated: DEPRECATED_FRAG, docUrl: 'gl_FragData.xhtml' }),
  v('gl_PrimitiveID', 'int', ['in'], ['fragment', 'geometry'], 'Index of the current primitive within the draw call.', { minVersion: 150 }),
  v('gl_Layer', 'int', ['in', 'out'], ['fragment', 'geometry'], 'Layer of a layered framebuffer: written by the geometry shader, read in the fragment shader.', { minVersion: 150 }),
  v('gl_ViewportIndex', 'int', ['in', 'out'], ['fragment', 'geometry'], 'Index of the viewport the primitive is sent to.', { minVersion: 410 }),
  v('gl_SampleID', 'int', ['in'], FS, 'Index of the sample being shaded when per-sample shading is on.', { minVersion: 400 }),
  v('gl_SamplePosition', 'vec2', ['in'], FS, 'Position of the current sample within the pixel, in `[0, 1]`.', { minVersion: 400 }),
  v('gl_SampleMaskIn', 'int[]', ['in'], FS, 'Bit mask of the samples covered by the primitive.', { minVersion: 400 }),
  v('gl_SampleMask', 'int[]', ['out'], FS, 'Bit mask of the samples that remain covered after the fragment shader.', { minVersion: 400 }),
  v('gl_HelperInvocation', 'bool', ['in'], FS, 'True if this invocation is a helper that only exists to compute derivatives.', { minVersion: 450 }),

  // ---- compute
  v('gl_NumWorkGroups', 'uvec3', ['in'], CS, 'Number of work groups dispatched in each dimension.', { minVersion: 430 }),
  v('gl_WorkGroupSize', 'uvec3', ['const'], CS, 'Size of a work group, as declared by `local_size_x/y/z`.', { minVersion: 430 }),
  v('gl_WorkGroupID', 'uvec3', ['in'], CS, 'Index of the current work group within the dispatch.', { minVersion: 430 }),
  v('gl_LocalInvocationID', 'uvec3', ['in'], CS, 'Index of the invocation within its work group.', { minVersion: 430 }),
  v('gl_GlobalInvocationID', 'uvec3', ['in'], CS, 'Global index of the invocation: `gl_WorkGroupID * gl_WorkGroupSize + gl_LocalInvocationID`.', { minVersion: 430 }),
  v('gl_LocalInvocationIndex', 'uint', ['in'], CS, 'Flattened index of the invocation within its work group.', { minVersion: 430 }),

  // ---- geometry / tessellation
  v('gl_InvocationID', 'int', ['in'], ['geometry', 'tessControl'], 'Index of the current geometry shader invocation, or of the output patch vertex in a tessellation control shader.', { minVersion: 400 }),
  v('gl_in', 'gl_PerVertex[]', ['in'], ['geometry', 'tessControl', 'tessEval'], 'Per-vertex built-in inputs (`gl_Position`, `gl_PointSize`, `gl_ClipDistance`) for each vertex of the input primitive.', { minVersion: 150 }),
  v('gl_PrimitiveIDIn', 'int', ['in'], GS, 'Index of the input primitive within the draw call.', { minVersion: 150 }),
  v('gl_PatchVerticesIn', 'int', ['in'], ['tessControl', 'tessEval'], 'Number of vertices in the input patch.', { minVersion: 400 }),
  v('gl_TessLevelOuter', 'float[4]', ['in', 'out'], ['tessControl', 'tessEval'], 'Outer tessellation levels, written by the control shader.', { minVersion: 400 }),
  v('gl_TessLevelInner', 'float[2]', ['in', 'out'], ['tessControl', 'tessEval'], 'Inner tessellation levels, written by the control shader.', { minVersion: 400 }),
  v('gl_TessCoord', 'vec3', ['in'], ['tessEval'], 'Coordinates of the vertex within the tessellated primitive domain.', { minVersion: 400 }),

  // ---- compatibility profile (kept so old shaders still resolve)
  v('gl_Vertex', 'vec4', ['in'], VS, 'Compatibility profile vertex position attribute.', { deprecated: 'Compatibility profile only.', docUrl: 'gl_Vertex.xhtml' }),
  v('gl_Normal', 'vec3', ['in'], VS, 'Compatibility profile vertex normal attribute.', { deprecated: 'Compatibility profile only.', docUrl: 'gl_Normal.xhtml' }),
  v('gl_Color', 'vec4', ['in'], ['vertex', 'fragment'], 'Compatibility profile primary colour.', { deprecated: 'Compatibility profile only.', docUrl: 'gl_Color.xhtml' }),
  v('gl_MultiTexCoord0', 'vec4', ['in'], VS, 'Compatibility profile texture coordinate attribute 0.', { deprecated: 'Compatibility profile only.', docUrl: 'gl_MultiTexCoord0.xhtml' }),
  v('gl_TexCoord', 'vec4[]', ['in', 'out'], ['vertex', 'fragment'], 'Compatibility profile texture coordinate varyings.', { deprecated: 'Compatibility profile only.', docUrl: 'gl_TexCoord.xhtml' }),
  v('gl_ModelViewMatrix', 'mat4', ['uniform'], undefined, 'Compatibility profile model-view matrix.', { deprecated: 'Compatibility profile only.', docUrl: 'gl_ModelViewMatrix.xhtml' }),
  v('gl_ProjectionMatrix', 'mat4', ['uniform'], undefined, 'Compatibility profile projection matrix.', { deprecated: 'Compatibility profile only.', docUrl: 'gl_ProjectionMatrix.xhtml' }),
  v('gl_ModelViewProjectionMatrix', 'mat4', ['uniform'], undefined, 'Compatibility profile model-view-projection matrix.', { deprecated: 'Compatibility profile only.', docUrl: 'gl_ModelViewProjectionMatrix.xhtml' }),
  v('gl_NormalMatrix', 'mat3', ['uniform'], undefined, 'Compatibility profile normal matrix.', { deprecated: 'Compatibility profile only.', docUrl: 'gl_NormalMatrix.xhtml' }),

  // ---- implementation constants
  ...(
    [
      ['gl_MaxDrawBuffers', 8, 'Maximum number of simultaneous fragment shader outputs.'],
      ['gl_MaxVertexAttribs', 16, 'Maximum number of vertex attributes.'],
      ['gl_MaxVertexUniformVectors', 256, 'Minimum number of `vec4` uniform vectors in a vertex shader (ES 3.0).'],
      ['gl_MaxFragmentUniformVectors', 224, 'Minimum number of `vec4` uniform vectors in a fragment shader (ES 3.0).'],
      ['gl_MaxVaryingVectors', 15, 'Minimum number of `vec4` varying vectors (ES 3.0).'],
      ['gl_MaxTextureImageUnits', 16, 'Minimum number of texture units usable from a fragment shader.'],
      ['gl_MaxCombinedTextureImageUnits', 32, 'Minimum number of texture units usable from all stages together.'],
      ['gl_MaxVertexTextureImageUnits', 16, 'Minimum number of texture units usable from a vertex shader.'],
      ['gl_MinProgramTexelOffset', -8, 'Minimum texel offset accepted by `textureOffset` and friends.'],
      ['gl_MaxProgramTexelOffset', 7, 'Maximum texel offset accepted by `textureOffset` and friends.'],
    ] as const
  ).map(([name, value, doc]) =>
    v(name, 'int', ['const'], undefined, `${doc} The spec minimum is ${value}; the actual limit depends on the implementation.`, { value: String(value), docUrl: '', minVersion: 130 }),
  ),
];
