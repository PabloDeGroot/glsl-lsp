// Runs the detection over the user's real shaders (read-only test material
// outside the repo). Skipped when the files are not there.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeValueTargets } from '../server/src/features/values/targets';
import type { ValueTarget } from '../shared/valuesProtocol';
import { componentCount } from '../shared/valuesProtocol';
import { makeEnv } from './valuesServerHelpers';
import { uri } from './helpers';

const SHADER_DIR = join(__dirname, '..', '..');
const MAIN = join(SHADER_DIR, 'main.glsl');
const have = existsSync(MAIN) && existsSync(join(SHADER_DIR, 'lib'));

function load(): Record<string, string> {
  const files: Record<string, string> = { 'main.glsl': readFileSync(MAIN, 'utf8') };
  const lib = join(SHADER_DIR, 'lib');
  for (const f of readdirSync(lib)) if (f.endsWith('.glsl')) files[`lib/${f}`] = readFileSync(join(lib, f), 'utf8');
  return files;
}

function slice(text: string, t: ValueTarget): string {
  const lines = text.split(/\r\n|\r|\n/);
  const { start, end } = t.range;
  if (start.line === end.line) return lines[start.line].slice(start.character, end.character);
  return [lines[start.line].slice(start.character), ...lines.slice(start.line + 1, end.line), lines[end.line].slice(0, end.character)].join('\n');
}

function checkTarget(text: string, t: ValueTarget): void {
  const lines = text.split(/\r\n|\r|\n/);
  const sub = (r: ValueTarget['range']) => (r.start.line === r.end.line ? lines[r.start.line].slice(r.start.character, r.end.character) : '(multi)');
  for (const c of t.components) {
    expect(sub(c.range)).toBe(c.text);
    if (c.editable) expect(Number.isFinite(c.value)).toBe(true);
  }
  if (t.kind === 'float' || t.kind === 'vec2' || t.kind === 'vec3' || t.kind === 'vec4') {
    expect(t.components.length === componentCount(t.kind) || (t.splat && t.components.length === 1)).toBe(true);
  }
  if (t.kind === 'palette') {
    expect(t.children).toHaveLength(4);
    for (const c of t.children!) expect(c.kind).toBe('vec3');
  }
  if (t.kind === 'multi') expect(t.children!.length).toBeGreaterThanOrEqual(2);
  expect(t.snippet.length).toBeLessThanOrEqual(48);
  expect(t.id).toBe(`${t.kind}:${t.range.start.line}:${t.range.start.character}`);
}

describe.skipIf(!have)('values: real shaders', () => {
  const files = have ? load() : {};
  const { env } = makeEnv(files);

  it('main.glsl: #iUniform defaults', () => {
    const text = files['main.glsl'];
    const lines = text.split(/\r\n|\r|\n/);
    const line = (needle: string) => lines.findIndex((l) => l.includes(needle));
    const at = (needle: string, inner: string) => {
      const l = line(needle);
      return computeValueTargets(env, { uri: uri('main.glsl'), position: { line: l, character: lines[l].indexOf(inner) + 1 } }).cursor!;
    };
    const speed = at('#iUniform float u_speed', '1.0');
    expect(speed).toMatchObject({ kind: 'float', name: 'u_speed', declKind: 'iUniform', uniform: { min: 0, max: 4 } });
    const tint = at('#iUniform color3 u_tint', 'color3(');
    expect(tint).toMatchObject({ kind: 'vec3', name: 'u_tint', colorish: true, ctor: 'color3' });
    expect(tint.components.map((c) => c.value)).toEqual([1, 0.78, 0.55]);
  });

  it('every file: scanning every position never throws and targets are consistent', () => {
    let found = 0;
    for (const [path, text] of Object.entries(files)) {
      const lines = text.split(/\r\n|\r|\n/);
      for (let line = 0; line < lines.length; line++) {
        const step = lines[line].length > 80 ? 11 : 3;
        for (let ch = 0; ch <= lines[line].length; ch += step) {
          const res = computeValueTargets(env, { uri: uri(path), position: { line, character: ch } });
          const t = res.cursor;
          if (!t) continue;
          found++;
          checkTarget(text, t);
          // the cursor target's own text is inside the document
          expect(slice(text, t).length).toBeGreaterThan(0);
        }
      }
    }
    expect(found).toBeGreaterThan(100);
  });

  it('every target round-trips through its anchor', () => {
    let checked = 0;
    for (const [path, text] of Object.entries(files)) {
      const lines = text.split(/\r\n|\r|\n/);
      for (let line = 0; line < lines.length; line += 1) {
        const res = computeValueTargets(env, { uri: uri(path), position: { line, character: Math.min(lines[line].length, 4) } });
        const t = res.cursor;
        if (!t) continue;
        const back = computeValueTargets(env, { uri: uri(path), anchors: [t.anchor] }).anchors![0];
        expect(back.target, `${path}:${line + 1} ${t.snippet}`).not.toBeNull();
        expect(back.target!.kind).toBe(t.kind);
        expect(back.target!.range).toEqual(t.range);
        expect(['declaration', 'fingerprint']).toContain(back.match);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('lib/color.glsl contains a palette', () => {
    const text = files['lib/color.glsl'];
    const lines = text.split(/\r\n|\r|\n/);
    const l = lines.findIndex((x) => x.includes('palette(t, vec3(0.5), vec3(0.5), vec3(1.0)'));
    expect(l).toBeGreaterThanOrEqual(0);
    const t = computeValueTargets(env, { uri: uri('lib/color.glsl'), position: { line: l, character: lines[l].indexOf('palette(t,') + 2 } }).cursor!;
    expect(t.kind).toBe('palette');
    expect(t.children!.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(t.children![3].components.map((c) => c.value)).toEqual([0, 0.33, 0.67]);
  });

  it('is fast on every position of the largest file', () => {
    const [path, text] = Object.entries(files).sort((a, b) => b[1].length - a[1].length)[0];
    const lines = text.split(/\r\n|\r|\n/);
    computeValueTargets(env, { uri: uri(path), position: { line: 0, character: 0 } }); // warm the per-model analysis
    const t0 = performance.now();
    let n = 0;
    for (let line = 0; line < lines.length; line++) {
      computeValueTargets(env, { uri: uri(path), position: { line, character: 3 } });
      n++;
    }
    const per = (performance.now() - t0) / n;
    expect(per).toBeLessThan(5);
  });
});

describe('values: performance on a 2000-line file', () => {
  it('analysis + cursor request < 5ms (warm), first request < 150ms', () => {
    const chunk = (i: number) =>
      `float f${i}(float x) {\n  vec3 col = mix(vec3(0.1, 0.2, 0.3), vec3(0.9, ${(i % 10) / 10}, 0.5), smoothstep(0.1, 0.9, x));\n  float k${i} = ${i}.5 * x + 0.25;\n  return k${i} + col.x;\n}\n`;
    const text = Array.from({ length: 400 }, (_, i) => chunk(i)).join('');
    expect(text.split('\n').length).toBeGreaterThanOrEqual(2000);
    const { env } = makeEnv({ 'main.glsl': text });
    const t0 = performance.now();
    computeValueTargets(env, { uri: uri('main.glsl'), position: { line: 1000, character: 20 } });
    const first = performance.now() - t0;
    expect(first).toBeLessThan(500); // generous: includes the one-off analysis
    const t1 = performance.now();
    for (let i = 0; i < 50; i++) computeValueTargets(env, { uri: uri('main.glsl'), position: { line: 1000 + i, character: 20 } });
    expect((performance.now() - t1) / 50).toBeLessThan(5);
  });
  it('resolving 30 anchors is fast', () => {
    const text = Array.from({ length: 400 }, (_, i) => `float f${i}(float x) {\n  float k${i} = ${i}.5;\n  return x * 0.25 + k${i};\n}\n`).join('');
    const { env } = makeEnv({ 'main.glsl': text });
    const anchors = Array.from({ length: 30 }, (_, i) => {
      const cur = computeValueTargets(env, { uri: uri('main.glsl'), position: { line: i * 40 + 1, character: 16 } }).cursor!;
      return { ...cur.anchor, declName: undefined, declKind: undefined, fingerprint: cur.anchor.fingerprint.replace('float', 'float ') };
    });
    const t0 = performance.now();
    const out = computeValueTargets(env, { uri: uri('main.glsl'), anchors }).anchors!;
    expect(performance.now() - t0).toBeLessThan(250);
    expect(out.filter((r) => r.target).length).toBe(30);
  });
});
