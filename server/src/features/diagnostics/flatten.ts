// Builds the single translation unit handed to glslangValidator and keeps a
// line map back to the original files.
//
// Shadertoy-style files (mainImage, where Shadertoy support applies) get a
// preamble with the Shadertoy uniforms and a generated `main()`. #include
// lines are replaced by the included file's text (each file once, like
// include guards would do), shader-toy directives (#iUniform, #iChannel,
// #iKeyboard) are turned into declarations or blanked. The configured
// environment (glslLsp.environment.*) adds its #defines and uniforms: after
// the Shadertoy preamble, or right after the root file's #version line for
// plain GLSL. Every output line maps to (uri, line) so glslang messages can
// be reported where the code was written.
//
// glslang checks plain GLSL with OpenGL rules unless the unit is Vulkan GLSL
// (glslLsp.diagnostics.glslang.targetEnv, `auto` detects it): then the
// environment uniforms get explicit bindings, as Vulkan requires.

import { splitArrayType, type Environment } from '../../builtins';
import { normalizeUri, type FileModel, type Range, type Workspace } from '../../core';

/** glslangValidator `-S` stage names. */
export type Stage = 'vert' | 'tesc' | 'tese' | 'geom' | 'frag' | 'comp' | 'rgen' | 'rint' | 'rahit' | 'rchit' | 'rmiss' | 'rcall' | 'mesh' | 'task';

/** glslLsp.diagnostics.glslang.targetEnv */
export type TargetEnvSetting = 'auto' | 'opengl' | 'vulkan1.0' | 'vulkan1.1' | 'vulkan1.2' | 'vulkan1.3';

export interface RootInclude {
  /** Line of the #include in the root file. */
  line: number;
  pathRange: Range;
  path: string;
  uri: string;
}

export interface LineOrigin {
  uri: string;
  /** 0-based line in `uri`. */
  line: number;
  /** For lines that came from an included file: the root-level #include that pulled them in. */
  via?: RootInclude;
}

export interface Flattened {
  source: string;
  /** Index = 0-based line of `source`; undefined for generated lines. */
  lineMap: (LineOrigin | undefined)[];
  stage: Stage;
  shadertoy: boolean;
  /** `--target-env` for glslang (`vulkan1.2`...); undefined: OpenGL rules. */
  targetEnv?: string;
  /** Every file inlined, root first. */
  files: string[];
  /**
   * 1-based lines of `source` holding a user #if/#ifdef/#ifndef that has no #endif in its file.
   * glslang reports those at the end of the unit (a generated line), so the mapper relocates them here.
   */
  unclosedConditionals: number[];
}

const STAGE_BY_EXT: Record<string, Stage> = {
  vert: 'vert',
  vs: 'vert',
  vsh: 'vert',
  frag: 'frag',
  fs: 'frag',
  fsh: 'frag',
  tesc: 'tesc',
  tese: 'tese',
  geom: 'geom',
  gs: 'geom',
  comp: 'comp',
  cs: 'comp',
  gsh: 'geom',
  vshader: 'vert',
  fshader: 'frag',
  gshader: 'geom',
  glslv: 'vert',
  glslf: 'frag',
  glslg: 'geom',
  rgen: 'rgen',
  rint: 'rint',
  rahit: 'rahit',
  rchit: 'rchit',
  rmiss: 'rmiss',
  rcall: 'rcall',
  mesh: 'mesh',
  task: 'task',
};

/** Stages that only exist in Vulkan GLSL. */
const VULKAN_STAGES: ReadonlySet<Stage> = new Set(['rgen', 'rint', 'rahit', 'rchit', 'rmiss', 'rcall', 'mesh', 'task']);

/** Target `auto` picks for Vulkan GLSL (1.2: ray tracing and mesh shaders need SPIR-V 1.4; supported by every recent glslang). */
const AUTO_VULKAN_TARGET = 'vulkan1.2';

/** Syntax only Vulkan GLSL accepts (descriptor sets, push constants, subpass inputs, separate textures and samplers, ...). */
const VULKAN_SYNTAX: RegExp[] = [
  /\blayout\s*\([^)]*\b(?:set\s*=|push_constant\b|constant_id\s*=|input_attachment_index\s*=|shaderRecord(?:EXT|NV)\b)/,
  /\b[iu]?subpassInput(?:MS)?\b/,
  /\bgl_(?:VertexIndex|InstanceIndex)\b/,
  /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(?:[iu]?texture(?:1D|2D|3D|Cube|2DRect|Buffer|1DArray|2DArray|CubeArray|2DMS|2DMSArray)|sampler|samplerShadow)\s+[A-Za-z_]/,
  /#\s*extension\s+GL_(?:KHR_vulkan_glsl|EXT_ray_tracing|NV_ray_tracing|EXT_ray_query|EXT_mesh_shader|EXT_buffer_reference\w*|EXT_nonuniform_qualifier|EXT_scalar_block_layout)\b/,
];

/** True when the source uses Vulkan-only GLSL (comments are ignored). */
export function usesVulkanGlsl(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');
  return VULKAN_SYNTAX.some((re) => re.test(code));
}

/** `--target-env` for a unit: undefined means OpenGL rules. Shadertoy wrappers are always OpenGL ES. */
export function resolveTargetEnv(setting: TargetEnvSetting, stage: Stage, source: string): string | undefined {
  if (setting === 'opengl') return undefined;
  if (setting !== 'auto') return setting;
  return VULKAN_STAGES.has(stage) || usesVulkanGlsl(source) ? AUTO_VULKAN_TARGET : undefined;
}

/**
 * Stage from the file name: `x.vert`, `x.vert.glsl`, `x.vs.glsl`... (default
 * fragment). The Vulkan-only stages count only as the last extension, so that
 * `skinned.mesh.glsl` stays a fragment shader.
 */
export function stageForUri(uri: string): Stage {
  const base = uri.toLowerCase().replace(/[?#].*$/, '').split('/').pop() ?? '';
  const parts = base.split('.').slice(1).reverse();
  for (const [i, ext] of parts.entries()) {
    if (ext === 'glsl') continue;
    const stage = STAGE_BY_EXT[ext];
    if (stage && (i === 0 || !VULKAN_STAGES.has(stage))) return stage;
  }
  return 'frag';
}

export interface RunPlan {
  stage: Stage;
  shadertoy: boolean;
}

/**
 * Decides whether (and how) a file can be validated on its own. Library files
 * return undefined. `shadertoy` says whether Shadertoy support applies to the
 * file (Workspace.shadertoyActive): only then is a `mainImage` file wrapped;
 * otherwise it is plain GLSL and needs its own `main` and `#version`.
 */
export function planValidation(model: FileModel, shadertoy: boolean): RunPlan | undefined {
  const hasMain = model.functions.some((f) => f.name === 'main' && !f.isPrototype);
  const hasMainImage = model.shadertoy.hasMainImage || model.functions.some((f) => f.name === 'mainImage' && !f.isPrototype);
  const stage = stageForUri(model.uri);
  if (hasMainImage && shadertoy) return { stage: 'frag', shadertoy: true };
  if (hasMain && model.glslVersion) return { stage, shadertoy: false };
  return undefined;
}

// ---------------------------------------------------------------- preamble

// Mirrors the preamble the stevensona shader-toy VS Code extension prepends in
// WebGL2 mode, plus Shadertoy's iFrameRate and iChannelTime, so whatever the
// preview accepts validates here too.
const SHADERTOY_UNIFORMS = [
  'uniform vec3 iResolution;',
  'uniform float iTime;',
  'uniform float iTimeDelta;',
  'uniform float iFrameRate;',
  'uniform int iFrame;',
  'uniform float iChannelTime[4];',
  'uniform vec3 iChannelResolution[10];',
  'uniform vec4 iMouse;',
  'uniform vec4 iMouseButton;',
  'uniform mat4 iViewMatrix;',
  'uniform sampler2D iKeyboard;',
  'uniform vec4 iDate;',
  'uniform float iSampleRate;',
  '#define iGlobalTime iTime',
  '#define iGlobalFrame iFrame',
  '#define SHADER_TOY',
];

const KEY_CODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Ctrl: 17, Alt: 18, Pause: 19, CapsLock: 20, Escape: 27, Space: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, Left: 37, Up: 38, Right: 39, Down: 40, Insert: 45, Delete: 46,
};

function keyboardStubs(): string[] {
  const lines = ['bool isKeyDown(int k) { return false; }', 'bool isKeyPressed(int k) { return false; }', 'bool isKeyToggled(int k) { return false; }', 'bool isKeyReleased(int k) { return false; }'];
  const consts: string[] = [];
  for (const [n, v] of Object.entries(KEY_CODES)) consts.push(`const int Key_${n} = ${v};`);
  for (let i = 0; i < 26; i++) consts.push(`const int Key_${String.fromCharCode(65 + i)} = ${65 + i};`);
  for (let i = 0; i < 10; i++) consts.push(`const int Key_${i} = ${48 + i};`);
  for (let i = 1; i <= 12; i++) consts.push(`const int Key_F${i} = ${111 + i};`);
  return [...lines, consts.join(' ')];
}

function samplerFor(type: string | undefined): string {
  const t = (type ?? '').toLowerCase();
  if (t === 'cubemap') return 'samplerCube';
  if (t === 'volume' || t === '3d') return 'sampler3D';
  return 'sampler2D';
}

function buildPreamble(info: { keyboard: boolean; channelTypes: Map<number, string> }): string[] {
  const lines = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'precision highp sampler2D;', 'precision highp sampler3D;', 'precision highp samplerCube;'];
  lines.push(...SHADERTOY_UNIFORMS);
  for (let i = 0; i < 4; i++) lines.push(`uniform ${samplerFor(info.channelTypes.get(i))} iChannel${i};`);
  if (info.keyboard) lines.push(...keyboardStubs());
  return lines;
}

const EPILOGUE = ['out vec4 _fragColor;', 'void main() { mainImage(_fragColor, gl_FragCoord.xy); }'];

/** Names the Shadertoy preamble declares or defines (environment entries never redeclare them). */
const SHADERTOY_PREAMBLE_NAMES: ReadonlySet<string> = new Set([
  ...SHADERTOY_UNIFORMS.map((l) => /(\w+)(?:\[\d+\])?;$|^#define (\w+)/.exec(l)).map((m) => m?.[1] ?? m?.[2] ?? ''),
  'iChannel0',
  'iChannel1',
  'iChannel2',
  'iChannel3',
]);

/** Types that take a precision qualifier (GLSL ES needs one for a uniform declared before the file's `precision` statement). */
const PRECISION_TYPE = /^(float|int|uint|[iu]?vec[234]|mat[234](x[234])?|[iu]?sampler\w+|[iu]?image\w+)$/;

/** Types that cannot be members of a uniform block. */
const OPAQUE_TYPE = /^(?:[iu]?sampler\w+|[iu]?image\w+|[iu]?texture\w+|[iu]?subpassInput\w*|atomic_uint)$/;

/** Descriptor set of the environment uniforms in Vulkan GLSL (high, to stay clear of the shader's own sets). */
const VULKAN_ENV_SET = 7;

/**
 * The environment's `#define` and `uniform` lines, skipping names the unit
 * declares itself (`declared`) so nothing is defined twice. Vulkan GLSL has no
 * loose non-opaque uniforms and wants a binding on every resource: the plain
 * uniforms go into one nameless block, every resource gets its own binding.
 */
export function environmentLines(env: Environment, declared: ReadonlySet<string>, options: { es: boolean; vulkan?: boolean }): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(env.defines)) {
    if (declared.has(name)) continue;
    lines.push(value ? `#define ${name} ${value}` : `#define ${name}`);
  }
  const members: string[] = [];
  let binding = 1;
  for (const u of env.uniforms) {
    if (declared.has(u.name)) continue;
    const { base, array } = splitArrayType(u.type);
    const precision = options.es && PRECISION_TYPE.test(base) ? 'highp ' : '';
    if (!options.vulkan) lines.push(`uniform ${precision}${base} ${u.name}${array};`);
    else if (OPAQUE_TYPE.test(base)) lines.push(`layout(set = ${VULKAN_ENV_SET}, binding = ${binding++}) uniform ${precision}${base} ${u.name}${array};`);
    else members.push(`${precision}${base} ${u.name}${array};`);
  }
  if (members.length) lines.push(`layout(set = ${VULKAN_ENV_SET}, binding = 0) uniform GlslLspEnvironment { ${members.join(' ')} };`);
  return lines;
}

// ---------------------------------------------------------------- flattening

const UNIFORM_TYPE_MAP: Record<string, string> = { color3: 'vec3', color4: 'vec4' };

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

export interface FlattenOptions {
  shadertoy: boolean;
  stage?: Stage;
  /** Which rules glslang applies (default `auto`: Vulkan when the unit uses Vulkan GLSL). */
  targetEnv?: TargetEnvSetting;
  /** Uniforms and defines of the shader runtime; defaults to the workspace builtins' environment. */
  environment?: Environment;
}

const GUARD_PREFIX = 'GLSLLSP_INCLUDED_';
/** Safety cap on the flattened size (conditional includes are inlined at every site). */
const MAX_LINES = 400_000;

export function flatten(ws: Workspace, rootUriIn: string, options: FlattenOptions): Flattened {
  const rootUri = normalizeUri(rootUriIn);
  const body: string[] = [];
  const bodyMap: (LineOrigin | undefined)[] = [];
  /** Lines outside every #if branch: only those decide whether the unit is Vulkan GLSL. */
  const unconditionalLines: string[] = [];
  const files: string[] = [];
  /** Files on the current include stack (cycles). */
  const stack = new Set<string>();
  /** Files already inlined outside any conditional: later includes of them are no-ops. */
  const unconditional = new Set<string>();
  /** Synthetic guard index per file, so the preprocessor itself dedupes conditional includes. */
  const guardIndex = new Map<string, number>();
  const declaredUniforms = new Set<string>();
  const channelTypes = new Map<number, string>();
  let keyboard = false;
  const unclosed: LineOrigin[] = [];

  const emit = (text: string, origin: LineOrigin, depth = 1) => {
    body.push(text);
    bodyMap.push(origin);
    if (depth === 0) unconditionalLines.push(text);
  };

  const visit = (uri: string, via: RootInclude | undefined, depth: number, condDepth: number) => {
    const model = ws.getModel(uri);
    if (!model) return;
    stack.add(uri);
    if (!files.includes(uri)) files.push(uri);
    const lines = splitLines(model.text);
    if (model.shadertoy.keyboard) keyboard = true;

    // Conditional nesting per line (include guards do not count).
    const lineDepth = new Array<number>(lines.length + 1).fill(0);
    const unclosedLines = new Set<number>();
    for (const c of model.conditionals) {
      if (!c.endif) {
        unclosedLines.add(c.branches[0].range.start.line);
        continue;
      }
      const first = c.branches[0];
      const isGuard = first.kind === 'ifndef' && !!c.macro && model.macros.some((m) => m.name === c.macro && m.isIncludeGuard);
      if (isGuard) continue;
      for (let l = first.range.start.line + 1; l < c.endif.range.start.line; l++) lineDepth[l]++;
    }

    // line -> what replaces it (the first line of a directive); continuation lines blank
    const replace = new Map<number, string | { include: (typeof model.includes)[number] }>();
    const blank = new Set<number>();
    for (const inc of model.includes) {
      replace.set(inc.range.start.line, { include: inc });
      for (let l = inc.range.start.line + 1; l <= inc.range.end.line; l++) blank.add(l);
    }
    for (const d of model.directives) {
      const first = d.range.start.line;
      const markBlank = () => {
        replace.set(first, '');
        for (let l = first + 1; l <= d.range.end.line; l++) blank.add(l);
      };
      if (d.kind === 'iChannel') {
        const t = /^iChannel(\d)::Type$/.exec(d.name);
        if (t) channelTypes.set(Number(t[1]), d.args.replace(/^["']|["']$/g, ''));
        markBlank();
      } else if (d.kind === 'iKeyboard') {
        keyboard = true;
        markBlank();
      } else if (d.kind === 'iUniform') {
        const m = /^(\w+)\s+(\w+)/.exec(d.args);
        if (m && !declaredUniforms.has(m[2])) {
          declaredUniforms.add(m[2]);
          replace.set(first, `uniform ${UNIFORM_TYPE_MAP[m[1]] ?? m[1]} ${m[2]};`);
          for (let l = first + 1; l <= d.range.end.line; l++) blank.add(l);
        } else markBlank();
      } else if ((d.kind === 'version' || /^i[A-Z]/.test(d.name)) && options.shadertoy) {
        // #version is supplied by the preamble; other #iXxx are shader-toy extension directives
        markBlank();
      } else if (d.kind === 'line') {
        // #line would renumber glslang's output and break the line map.
        markBlank();
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const origin: LineOrigin = { uri, line: i, via };
      if (unclosedLines.has(i)) unclosed.push(origin);
      const rep = replace.get(i);
      if (blank.has(i)) emit('', origin);
      else if (rep === undefined) emit(lines[i], origin, condDepth + lineDepth[i]);
      else if (typeof rep === 'string') emit(rep, origin);
      else {
        const target = rep.include.resolvedUri;
        const d = condDepth + lineDepth[i];
        if (target && !stack.has(target) && !unconditional.has(target) && depth < 64 && body.length < MAX_LINES && ws.getModel(target)) {
          const next: RootInclude | undefined = via ?? { line: i, pathRange: rep.include.pathRange, path: rep.include.path, uri: target };
          // The include line becomes a synthetic guard: inside an inactive #if branch the
          // preprocessor drops it, and a second include of the same file is a no-op.
          let n = guardIndex.get(target);
          if (n === undefined) guardIndex.set(target, (n = guardIndex.size));
          emit(`#ifndef ${GUARD_PREFIX}${n}`, origin);
          emitGenerated(`#define ${GUARD_PREFIX}${n}`);
          visit(target, next, depth + 1, d);
          emitGenerated('#endif');
          if (d === 0) unconditional.add(target);
        } else {
          emit('', origin);
        }
      }
    }
    stack.delete(uri);
  };

  const emitGenerated = (text: string) => {
    body.push(text);
    bodyMap.push(undefined);
  };

  visit(rootUri, undefined, 0, 0);

  const unclosedIn = (map: (LineOrigin | undefined)[]) => unclosed.map((o) => map.indexOf(o) + 1).filter((l) => l > 0);
  const stage = options.stage ?? stageForUri(rootUri);

  // Names the unit declares itself: the environment must not redeclare them.
  const env = options.environment ?? ws.builtins.environment;
  const declared = new Set<string>(declaredUniforms);
  for (const f of files) {
    const model = ws.getModel(f);
    for (const sym of model?.symbols ?? []) if (sym.name) declared.add(sym.name);
    // Fields of a block without an instance name are globals too (`uniform UBO { float uTime; };`).
    for (const b of model?.blocks ?? []) if (!b.instanceName) for (const fld of b.fields) declared.add(fld.name);
  }
  if (options.shadertoy) for (const n of SHADERTOY_PREAMBLE_NAMES) declared.add(n);

  if (!options.shadertoy) {
    const version = ws.getModel(rootUri)?.glslVersion;
    // A Vulkan construct inside `#ifdef USE_VULKAN` says nothing about the branch glslang compiles.
    const targetEnv = resolveTargetEnv(options.targetEnv ?? 'auto', stage, unconditionalLines.join('\n'));
    const envLines = environmentLines(env, declared, { es: version?.profile === 'es' || version?.number === 100, vulkan: !!targetEnv });
    if (envLines.length) {
      // Right after the root's #version line (it must come first), else at the very top.
      const at = version ? bodyMap.findIndex((o) => o?.uri === rootUri && o.line === version.range.end.line) + 1 : 0;
      body.splice(at, 0, ...envLines);
      bodyMap.splice(at, 0, ...envLines.map(() => undefined));
    }
    return { source: body.join('\n') + '\n', lineMap: bodyMap, stage, shadertoy: false, targetEnv, files, unclosedConditionals: unclosedIn(bodyMap) };
  }
  const preamble = [...buildPreamble({ keyboard, channelTypes }), ...environmentLines(env, declared, { es: true })];
  const lineMap: (LineOrigin | undefined)[] = [...preamble.map(() => undefined), ...bodyMap, ...EPILOGUE.map(() => undefined)];
  const source = [...preamble, ...body, ...EPILOGUE].join('\n') + '\n';
  return { source, lineMap, stage: 'frag', shadertoy: true, files, unclosedConditionals: unclosedIn(lineMap) };
}
