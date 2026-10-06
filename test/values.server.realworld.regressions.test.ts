// Review regressions reproduced on the user's real shaders (read-only test
// material outside the repo). Skipped when the files are not there.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeValueTargets } from '../server/src/features/values/targets';
import type { PinAnchor } from '../shared/valuesProtocol';
import { uri } from './helpers';
import { makeEnv } from './valuesServerHelpers';

const ROOT = join(__dirname, '..', '..');
const FILES = ['lib/color.glsl', 'lib/procedural.glsl', 'cubemap.glsl', 'channels.glsl'];
const have = FILES.every((f) => existsSync(join(ROOT, f)));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n?/g, '\n');

function cursorAt(file: string, text: string, needle: string, inner: string) {
  const lines = text.split('\n');
  const line = lines.findIndex((l) => l.includes(needle));
  const { env } = makeEnv({ [file]: text });
  return computeValueTargets(env, { uri: uri(file), position: { line, character: lines[line].indexOf(inner) + 1 } }).cursor!;
}

function resolveIn(file: string, text: string, anchor: PinAnchor) {
  const { env } = makeEnv({ [file]: text });
  return computeValueTargets(env, { uri: uri(file), anchors: [{ ...anchor, uri: uri(file) }] }).anchors![0];
}

function insertAfter(text: string, needle: string, insert: string): string {
  const i = text.indexOf(needle);
  const eol = text.indexOf('\n', i);
  return text.slice(0, eol + 1) + insert + text.slice(eol + 1);
}

describe.skipIf(!have)('values review regressions on real shaders', () => {
  it('lib/color.glsl: turbo LUT stop is a color, named lut[i], and an edit above keeps the pin on it', () => {
    const text = read('lib/color.glsl');
    const t = cursorAt('lib/color.glsl', text, 'vec3(0.9290, 0.8173, 0.2261)', '0.9290');
    expect(t.kind).toBe('vec3');
    expect(t.colorish).toBe(true);
    expect(t.name).toMatch(/^lut\[\d+\]$/);
    const edited = insertAfter(text, 'vec3 turbo(float t) {', '    // a comment\n');
    const r = resolveIn('lib/color.glsl', edited, t.anchor);
    expect(r.target!.components.map((c) => c.text)).toEqual(['0.9290', '0.8173', '0.2261']);
  });
  it('lib/color.glsl: the HSV argument of hsv2rgb is not offered as an RGB color', () => {
    const text = read('lib/color.glsl');
    expect(cursorAt('lib/color.glsl', text, 'hsv2rgb(vec3(t, 1.0, 1.0))', '1.0, 1.0)').colorish).toBe(false);
  });
  it('lib/procedural.glsl: the sfbm multi stays in sfbm after a helper is inserted above it', () => {
    const text = read('lib/procedural.glsl');
    const lines = text.split('\n');
    const line = lines.findIndex((l) => l.startsWith('float sfbm(vec2 p')) + 1;
    const { env } = makeEnv({ 'lib/procedural.glsl': text });
    const t = computeValueTargets(env, { uri: uri('lib/procedural.glsl'), position: { line, character: 0 } }).cursor!;
    expect(t).toMatchObject({ kind: 'multi', name: 'sum', functionName: 'sfbm' });
    const helper = 'float helperX(float x) {\n' + '    x = x * 1.5 + 0.25;\n'.repeat(13) + '    return x;\n}\n';
    const edited = text.replace('float sfbm(vec2 p', helper + 'float sfbm(vec2 p');
    const r = resolveIn('lib/procedural.glsl', edited, t.anchor);
    expect(r.target!.functionName).toBe('sfbm');
    expect(r.target!.range.start.line).toBe(line + 16); // the helper is 16 lines
  });
  it('cubemap.glsl: face colors picked by a ternary are colors; the sun direction is labelled', () => {
    const text = read('cubemap.glsl');
    expect(cursorAt('cubemap.glsl', text, 'vec3(0.95, 0.35, 0.35)', '0.95').colorish).toBe(true);
    expect(cursorAt('cubemap.glsl', text, 'vec3 sun = normalize(vec3(0.34', '0.34').name).toBe('sun · normalize');
  });
  it('channels.glsl: a literal inside a locked vec2 argument is reachable', () => {
    const text = read('channels.glsl');
    const t = cursorAt('channels.glsl', text, '1.3 - t * 0.15', '0.15');
    expect(t.kind).toBe('float');
    expect(t.components[0]).toMatchObject({ text: '0.15', editable: true });
  });
});
