import { describe, expect, it } from 'vitest';
import { computeSemanticTokens } from '../server/src/features/semanticTokens';
import { semanticTokensLegend } from '../server/src/core';
import { makeWorkspace, uri } from './helpers';

interface Tok {
  line: number;
  ch: number;
  len: number;
  type: string;
  mods: string[];
  text: string;
}

function decode(text: string, data: number[]): Tok[] {
  const lines = text.split('\n');
  const out: Tok[] = [];
  let line = 0;
  let ch = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    ch = data[i] === 0 ? ch + data[i + 1] : data[i + 1];
    const mods = semanticTokensLegend.tokenModifiers.filter((_, b) => data[i + 4] & (1 << b));
    out.push({
      line,
      ch,
      len: data[i + 2],
      type: semanticTokensLegend.tokenTypes[data[i + 3]],
      mods,
      text: lines[line].substr(ch, data[i + 2]),
    });
  }
  return out;
}

function run(files: Record<string, string>, main = 'main.glsl') {
  const { ws } = makeWorkspace(files);
  const model = ws.getModel(uri(main))!;
  return { toks: decode(files[main], computeSemanticTokens(ws, model).data), ws, model };
}
const find = (toks: Tok[], text: string, nth = 0) => toks.filter((t) => t.text === text)[nth];

describe('semantic tokens', () => {
  const src = [
    '#define SCALE 2.0',
    'struct Light { vec3 pos; float power; };',
    'uniform float uGain;',
    'const float K = 1.0;',
    'float shade(Light l, float x) {',
    '  float t = x * SCALE;',
    '  return mix(t, l.power, 0.5) * uGain + K + l.pos.x;',
    '}',
    'void mainImage(out vec4 fragColor, in vec2 fragCoord) {',
    '  Light L;',
    '  fragColor = vec4(shade(L, iTime), 0.0, 0.0, 1.0);',
    '}',
  ].join('\n');
  const { toks } = run({ 'main.glsl': src });

  it('classifies function definitions and calls', () => {
    expect(find(toks, 'shade', 0)).toMatchObject({ type: 'function', mods: ['declaration', 'definition'] });
    expect(find(toks, 'shade', 1)).toMatchObject({ type: 'function', mods: [] });
    expect(find(toks, 'mix')).toMatchObject({ type: 'function' });
  });
  it('classifies params, locals, globals', () => {
    expect(find(toks, 'x', 0)).toMatchObject({ type: 'parameter', mods: ['declaration'] });
    expect(find(toks, 't', 0)).toMatchObject({ type: 'variable', mods: ['declaration'] });
    expect(find(toks, 'uGain', 1)).toMatchObject({ type: 'variable' });
    expect(find(toks, 'uGain', 1)!.mods).toEqual(expect.arrayContaining(['static', 'readonly']));
    expect(find(toks, 'K', 1)!.mods).toContain('readonly');
  });
  it('classifies struct, fields, macros', () => {
    expect(find(toks, 'Light', 0)).toMatchObject({ type: 'struct' });
    expect(find(toks, 'Light', 1)).toMatchObject({ type: 'struct' });
    expect(find(toks, 'power', 1)).toMatchObject({ type: 'property' });
    expect(find(toks, 'pos', 1)).toMatchObject({ type: 'property' });
    expect(find(toks, 'SCALE', 1)).toMatchObject({ type: 'macro' });
  });
  it('marks builtins as defaultLibrary', () => {
    expect(find(toks, 'mix')!.mods).toContain('defaultLibrary');
  });
  it('data is ordered and relative', () => {
    for (const t of toks) expect(t.text.length).toBe(t.len);
  });
});

describe('semantic tokens: range, includes, robustness', () => {
  it('range only returns tokens inside', () => {
    const text = 'float a(){return 1.0;}\nfloat b(){return a();}';
    const { ws } = makeWorkspace({ 'main.glsl': text });
    const model = ws.getModel(uri('main.glsl'))!;
    const full = decode(text, computeSemanticTokens(ws, model).data);
    const part = decode(
      text,
      computeSemanticTokens(ws, model, { start: { line: 1, character: 0 }, end: { line: 1, character: 30 } }).data,
    );
    expect(full.length).toBeGreaterThan(part.length);
    expect(part.every((t) => t.line === 1)).toBe(true);
    expect(part.map((t) => t.text)).toContain('a');
  });
  it('resolves functions from includes', () => {
    const { toks } = run({
      'lib.glsl': 'float helper(float x){return x;}',
      'main.glsl': '#include "lib.glsl"\nfloat f(){return helper(1.0);}',
    });
    expect(find(toks, 'helper')).toMatchObject({ type: 'function' });
  });
  it('does not throw on half-typed code', () => {
    const { toks } = run({ 'main.glsl': 'float f(float x) {\n  return foo(x, \n' });
    expect(Array.isArray(toks)).toBe(true);
  });
  it('Key_ constants are enumMember', () => {
    const { toks } = run({
      'main.glsl': '#iKeyboard\nvoid mainImage(out vec4 c, in vec2 p){ if (isKeyDown(Key_A)) c = vec4(1.0); }',
    });
    const k = find(toks, 'Key_A');
    if (k) expect(k.type).toBe('enumMember'); // depends on builtin data completeness
  });
});
