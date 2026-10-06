// Shared fixtures for completion / code action tests: an in-memory project
// laid out like the user's shader repo (root shaders, lib/, lygia/...).
import type { CompletionItem, CompletionList, TextEdit } from 'vscode-languageserver/node';
import { computeCompletion, type CompletionEnv } from '../server/src/features/completion';
import { cursor, makeWorkspace, uri } from './helpers';

export const LIB_FILES: Record<string, string> = {
  'lib/common.glsl': [
    '// lib/common.glsl - coordinates and math helpers.',
    '',
    '#include "../lygia/math/const.glsl"',
    '',
    '// Centered and aspect corrected.',
    'vec2 uvCentered(vec2 fragCoord, vec2 res) { return (fragCoord * 2.0 - res) / res.y; }',
    '',
  ].join('\n'),
  'lib/procedural.glsl': [
    '// lib/procedural.glsl - noise.',
    '#include "../lygia/generative/gnoise.glsl"',
    '',
    '// Fractal sum of gnoise.',
    'float fbmNoise(vec2 p, int octaves) { return gnoise(p); }',
    '',
  ].join('\n'),
  'lygia/math/const.glsl': '/*\ncontributors: Patricio Gonzalez Vivo\ndescription: some useful math constants\nlicense: MIT\n*/\n#ifndef PI\n#define PI 3.1415926535897932384626433832795\n#endif\n',
  'lygia/math/saturate.glsl':
    '/*\ncontributors: Patricio Gonzalez Vivo\ndescription: clamp a value between 0 and 1\nuse: <float|vec2|vec3|vec4> saturate(<float|vec2|vec3|vec4> value)\n*/\n#if !defined(FNC_SATURATE) && !defined(saturate)\n#define FNC_SATURATE\n#define saturate(V) clamp(V, 0.0, 1.0)\n#endif\n',
  'lygia/generative/random.glsl':
    '/*\ncontributors: Patricio Gonzalez Vivo\ndescription: pass a value and get some random normalize value between 0 and 1\nuse: float random[2|3](<float|vec2|vec3> value)\n*/\n#ifndef FNC_RANDOM\n#define FNC_RANDOM\nfloat random(float x) { return fract(sin(x) * 43758.5453); }\nfloat random(vec2 st) { return random(st.x); }\n#endif\n',
  'lygia/generative/gnoise.glsl':
    '#include "random.glsl"\n\n/*\ncontributors: Patricio Gonzalez Vivo\ndescription: Gradient Noise\nuse: gnoise(<float> x)\noptions:\n    - GNOISE_FNC: noise function\nlicense: MIT\n*/\n#ifndef FNC_GNOISE\n#define FNC_GNOISE\nfloat gnoise(float x) { return random(x); }\nfloat gnoise(vec2 st) { return random(st); }\n#endif\n',
  'lygia/sdf/circleSDF.glsl':
    '/*\ncontributors: Patricio Gonzalez Vivo\ndescription: Returns a circle-shaped SDF.\nuse: circleSDF(vec2 st[, vec2 center])\n*/\n#ifndef FNC_CIRCLESDF\n#define FNC_CIRCLESDF\nstruct CircleInfo { vec2 center; float radius; };\nfloat circleSDF(in vec2 v) { return length(v); }\n#endif\n',
  'other/shader2.glsl': 'float onlyInShader(float x) { return x; }\nvoid mainImage(out vec4 c, in vec2 f) { c = vec4(onlyInShader(1.0)); }\n',
};

export interface CompleteOptions extends Partial<Omit<CompletionEnv, 'workspace'>> {
  path?: string;
  files?: Record<string, string>;
  triggerCharacter?: string;
}

/** Completion at the `|` marker of `textWithCursor`, placed at `options.path` (default main.glsl) in the fixture project. */
export function complete(textWithCursor: string, options: CompleteOptions = {}) {
  const path = options.path ?? 'main.glsl';
  const { text, position } = cursor(textWithCursor);
  const { ws } = makeWorkspace({ ...LIB_FILES, ...(options.files ?? {}), [path]: text });
  const env: CompletionEnv = { workspace: ws, snippetSupport: options.snippetSupport ?? true, autoInclude: options.autoInclude ?? true };
  const result = computeCompletion(env, {
    textDocument: { uri: uri(path) },
    position,
    context: options.triggerCharacter ? { triggerKind: 2, triggerCharacter: options.triggerCharacter } : { triggerKind: 1 },
  });
  return { result, ws, env, text, position };
}

export function itemsOf(result: CompletionList | null): CompletionItem[] {
  return result?.items ?? [];
}

export function labels(result: CompletionList | null): string[] {
  return itemsOf(result).map((i) => i.label);
}

export function find(result: CompletionList | null, label: string, description?: string): CompletionItem | undefined {
  return itemsOf(result).find((i) => i.label === label && (description === undefined || i.labelDetails?.description === description));
}

/** Applies non-overlapping text edits to `text`. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const lines = text.split('\n');
  const offsetOf = (p: { line: number; character: number }) => {
    let o = 0;
    for (let i = 0; i < p.line && i < lines.length; i++) o += lines[i].length + 1;
    return Math.min(o + p.character, text.length);
  };
  const sorted = [...edits].sort((a, b) => offsetOf(b.range.start) - offsetOf(a.range.start));
  let out = text;
  for (const e of sorted) out = out.slice(0, offsetOf(e.range.start)) + e.newText + out.slice(offsetOf(e.range.end));
  return out;
}
