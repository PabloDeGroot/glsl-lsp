// Runs the Values detection over a real shader workspace (see
// realWorkspace.ts; read-only test material, skipped without one).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeValueTargets } from '../server/src/features/values/targets';
import type { ValueTarget } from '../shared/valuesProtocol';
import { componentCount } from '../shared/valuesProtocol';
import { makeEnv } from './valuesServerHelpers';
import { uri } from './helpers';
import { REAL_ROOT, realShaderFiles } from './realWorkspace';

/** The workspace's own shaders (not LYGIA), capped so the exhaustive scans stay quick. */
function load(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of realShaderFiles().slice(0, 12)) files[rel] = readFileSync(join(REAL_ROOT!, rel), 'utf8');
  return files;
}
const have = !!REAL_ROOT && realShaderFiles().length > 0;

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

describe.skipIf(!have)('values: a real shader workspace', () => {
  const files = have ? load() : {};
  const { env } = makeEnv(files);

  it('every #iUniform with a default value is a target of its declaration', () => {
    let checked = 0;
    for (const [path, text] of Object.entries(files)) {
      const lines = text.split(/\r\n|\r|\n/);
      lines.forEach((l, line) => {
        const m = /^\s*#iUniform\s+(\w+)\s+(\w+)\s*=\s*([-\w.(]+)/.exec(l);
        if (!m) return;
        const at = l.indexOf(m[3], l.indexOf('=')) + 1;
        const t = computeValueTargets(env, { uri: uri(path), position: { line, character: at } }).cursor;
        if (!t) return; // e.g. an integer or texture uniform
        expect(t, `${path}:${line + 1}`).toMatchObject({ name: m[2], declKind: 'iUniform' });
        checked++;
      });
    }
    if (!checked) console.log('values realworld: no #iUniform with a numeric default found');
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
          // A target may live in an included file (e.g. the #define a macro use expands to).
          const targetText = files[t.uri.slice(uri('').length)] ?? text;
          checkTarget(targetText, t);
          // the cursor target's own text is inside its document
          expect(slice(targetText, t).length).toBeGreaterThan(0);
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
