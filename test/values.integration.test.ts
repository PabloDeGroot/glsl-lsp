// Values panel, all three layers without VS Code:
//   server   computeValueTargets          (what glslLsp/valueTargets answers)
//   webview  chooseWidget / flatValues / valuesMatch (which widget, what a drag sends)
//   client   buildGroups / buildReplacement (how the edit lands in the document)
// and back to the server, which must then report the written values.

import { describe, expect, it } from 'vitest';
import { buildGroups, buildReplacement, spanOf } from '../client/src/values/editText';
import { labelFor } from '../client/src/values/rows';
import { computeValueTargets } from '../server/src/features/values/targets';
import type { Position, ValueTarget } from '../shared/valuesProtocol';
import { chooseWidget, flatValues, valuesMatch } from '../webview/src/math/targets';
import { uri } from './helpers';
import { makeEnv } from './valuesServerHelpers';

const SRC = [
  '#iUniform float u_speed = 1.0 in { 0.0, 4.0 }',
  '#iUniform color3 u_tint = color3(1.0, 0.78, 0.55)',
  'vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(6.28318 * (c * t + d)); }',
  'void mainImage(out vec4 fragColor, in vec2 fragCoord) {',
  '    vec2 p = fragCoord * 0.01;',
  '    float d = length(p - vec2(0.42, 0.26)) - 0.25;',
  '    vec3 dir = normalize(vec3(0.3, 0.8, 0.52));',
  '    vec3 pal = palette(d, vec3(0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5), vec3(1.0, 1.0, 1.0), vec3(0.0, 0.33, 0.67));',
  '    fragColor = vec4(pal * u_tint * dot(dir, vec3(0.0, 1.0, 0.0)), 1.0);',
  '}',
  '',
].join('\n');

function posOf(text: string, needle: string, delta: number): Position {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`missing ${needle}`);
  const before = text.slice(0, i + delta).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}

function query(text: string, needle: string, delta: number): ValueTarget {
  const { env } = makeEnv({ 'main.glsl': text });
  const r = computeValueTargets(env, { uri: uri('main.glsl'), position: posOf(text, needle, delta) });
  if (!r.cursor) throw new Error(`no target at ${needle}`);
  return r.cursor;
}

/** What the client's EditApplier does for one gesture, on a plain string. */
function applyEdit(text: string, t: ValueTarget, values: (number | null)[], decimals: number): string {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const offsetAt = (p: Position) => lineStarts[p.line] + p.character;
  const groups = buildGroups(t, offsetAt);
  const span = spanOf(t, groups, offsetAt);
  // The client refuses to edit when the document no longer has the component text.
  for (const g of groups) for (const s of g.slots) if (s.editable) expect(text.slice(s.start, s.end)).toBe(s.text);
  const replaced = buildReplacement(text.slice(span.start, span.end), span.start, groups, values, decimals, 4, text[span.start - 1] ?? '');
  return text.slice(0, span.start) + replaced + text.slice(span.end);
}

describe('values pipeline: server -> webview -> client -> server', () => {
  it('#iUniform float: slider with the uniform range, drag writes a float literal', () => {
    const t = query(SRC, 'u_speed = 1.0', 'u_speed = 1'.length);
    expect(chooseWidget(t)).toBe('slider');
    expect(t.uniform).toMatchObject({ min: 0, max: 4 });
    expect(labelFor(t)).toBe('u_speed');
    const edited = applyEdit(SRC, t, [2.5], 2);
    expect(edited.split('\n')[0]).toBe('#iUniform float u_speed = 2.5 in { 0.0, 4.0 }');
    const again = query(edited, 'u_speed = 2.5', 'u_speed = 2'.length);
    expect(valuesMatch(again, [2.5], 2)).toBe(true);
    // Whole numbers keep a '.' so the literal stays a float.
    expect(applyEdit(SRC, t, [3], 2).split('\n')[0]).toContain('u_speed = 3.0 in');
  });

  it('#iUniform color3: colour picker; RGB edit keeps the color3 constructor', () => {
    const t = query(SRC, 'color3(1.0, 0.78', 'color3(1.'.length);
    expect(chooseWidget(t)).toBe('color');
    expect(chooseWidget(t, { mode: 'vector' })).toBe('vector');
    expect(flatValues(t)).toEqual([1, 0.78, 0.55]);
    const edited = applyEdit(SRC, t, [0.2, null, 0.9], 3);
    expect(edited.split('\n')[1]).toBe('#iUniform color3 u_tint = color3(0.2, 0.78, 0.9)');
    expect(valuesMatch(query(edited, 'color3(0.2', 'color3('.length), [0.2, 0.78, 0.9], 3)).toBe(true);
  });

  it('vec2: trackpad; negative values after a binary minus stay valid GLSL', () => {
    const t = query(SRC, 'vec2(0.42, 0.26)', 'vec2(0.4'.length);
    expect(chooseWidget(t)).toBe('trackpad');
    const edited = applyEdit(SRC, t, [-0.1, 0.5], 2);
    expect(edited).toContain('p - vec2(-0.1, 0.5)');
  });

  it('a lone float literal: slider, and the edit touches only that literal', () => {
    const t = query(SRC, ') - 0.25;', ') - 0.2'.length);
    expect(t.kind).toBe('float');
    expect(chooseWidget(t)).toBe('slider');
    const edited = applyEdit(SRC, t, [0.125], 3);
    expect(edited).toContain('vec2(0.42, 0.26)) - 0.125;');
  });

  it('direction vec3: trackball widget', () => {
    const t = query(SRC, 'vec3(0.3, 0.8, 0.52)', 'vec3(0.'.length);
    expect(t.colorish).toBe(false);
    expect(chooseWidget(t)).toBe('vector');
  });

  it('iq palette: palette editor; a preset (12 values, no childIndex) rewrites all four vec3s', () => {
    const t = query(SRC, 'palette(d, vec3', 'palette('.length);
    expect(t.kind).toBe('palette');
    expect(chooseWidget(t)).toBe('palette');
    expect(t.children!.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(flatValues(t)).toHaveLength(12);
    const preset = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 1, 0, 0.1, 0.2];
    const edited = applyEdit(SRC, t, preset, 2);
    expect(edited).toContain('palette(d, vec3(0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5), vec3(1.0, 1.0, 1.0), vec3(0.0, 0.1, 0.2))');
    // A child edit addresses only that vec3.
    const child = t.children![3];
    expect(chooseWidget(child)).not.toBe('palette');
    expect(applyEdit(SRC, child, [0.25, null, null], 2)).toContain('vec3(0.25, 0.33, 0.67))');
  });
});
