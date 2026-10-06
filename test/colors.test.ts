import { describe, expect, it } from 'vitest';
import {
  computeColorPresentations,
  computeDocumentColors,
  formatColorPresentation,
  formatComponent,
  identifierWords,
} from '../server/src/features/colors';
import { parseText } from './helpers';

type Mode = 'heuristic' | 'all' | 'off';
const colors = (t: string, mode: Mode = 'heuristic') => computeDocumentColors(parseText(t), mode);
const texts = (t: string, mode: Mode = 'heuristic') => {
  const m = parseText(t);
  return computeDocumentColors(m, mode).map((c) => m.text.slice(m.lines.offsetAt(c.range.start), m.lines.offsetAt(c.range.end)));
};

describe('document colors (heuristic)', () => {
  it('detects named color assignments', () => {
    expect(texts('void f(){ vec3 col = vec3(1.0, 0.5, 0.25); }')).toEqual(['vec3(1.0, 0.5, 0.25)']);
    expect(texts('const vec3 skyTint = vec3(0.2,0.4,0.8);')).toHaveLength(1);
    expect(texts('void f(out vec4 fragColor){ fragColor = vec4(0.1, 0.2, 0.3, 1.0); }')).toHaveLength(1);
    expect(texts('void f(){ vec3 c; c.rgb = vec3(1.0); col += vec3(0.5); }')).toHaveLength(2);
  });
  it('ignores non-color names', () => {
    expect(texts('void f(){ vec3 pos = vec3(0.0, 1.0, 0.5); vec3 collision = vec3(0.5); }')).toEqual([]);
  });
  it('uses enclosing calls and returns', () => {
    expect(texts('void f(){ vec3 x = mix(vec3(1.0,0.0,0.0), vec3(0.0), 0.5); }')).toEqual([]);
    expect(texts('void f(){ vec3 col = mix(vec3(1.0,0.0,0.0), vec3(0.0,0.0,1.0), 0.5); }')).toHaveLength(2);
    expect(texts('vec3 skyColor(){ return vec3(0.3, 0.5, 0.9); }')).toHaveLength(1);
    expect(texts('vec3 other(){ return vec3(0.3, 0.5, 0.9); }')).toEqual([]);
    expect(texts('void f(){ setColor(vec3(1.0, 0.0, 0.0)); }')).toHaveLength(1);
    expect(texts('void f(){ vec3 col = vec3(0.1) * vec3(0.5, 0.5, 1.0); }')).toHaveLength(2);
    expect(texts('#define SKY_COLOR vec3(0.3, 0.5, 0.9)\n')).toHaveLength(1);
  });
  it('gray and vec4 values', () => {
    const [g] = colors('vec3 col = vec3(0.5);');
    expect(g.color).toEqual({ red: 0.5, green: 0.5, blue: 0.5, alpha: 1 });
    const [v] = colors('vec4 col = vec4(0.1, 0.2, 0.3, 0.4);');
    expect(v.color).toEqual({ red: 0.1, green: 0.2, blue: 0.3, alpha: 0.4 });
  });
  it('rejects out of range, expressions, wrong arity, unclosed', () => {
    expect(colors('vec3 col = vec3(1.5, 0.0, 0.0);')).toEqual([]);
    expect(colors('vec3 col = vec3(-0.5, 0.0, 0.0);')).toEqual([]);
    expect(colors('vec3 col = vec3(a, 0.0, 0.0);')).toEqual([]);
    expect(colors('vec3 col = vec3(0.1, 0.2);')).toEqual([]);
    expect(colors('vec3 col = vec3(0.1, 0.2, 0.3')).toEqual([]);
    expect(colors('vec3 col = vec3(0.1, 0.2, 0.3+0.1);')).toEqual([]);
  });
  it('all mode accepts any literal, off disables', () => {
    expect(texts('vec3 pos = vec3(0.0, 1.0, 0.5);', 'all')).toHaveLength(1);
    expect(texts('vec3 col = vec3(0.0, 1.0, 0.5);', 'off')).toEqual([]);
  });
  it('#iUniform color3 defaults', () => {
    const t = '#iUniform color3 u_tint = color3(0.2, 0.4, 0.6)\n#iUniform float u_s = 1.0 in { 0.0, 2.0 }\n';
    expect(texts(t)).toEqual(['color3(0.2, 0.4, 0.6)']);
    expect(colors(t)[0].color.blue).toBeCloseTo(0.6);
  });
  it('does not throw on garbage', () => {
    expect(() => colors('vec3 col = vec3(((( ;;; } {{ vec4(')).not.toThrow();
  });
});

describe('color presentation', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
  it('formats components', () => {
    expect(formatComponent(0.5)).toBe('0.5');
    expect(formatComponent(1)).toBe('1.0');
    expect(formatComponent(0)).toBe('0.0');
    expect(formatComponent(0.12345)).toBe('0.123');
    expect(formatComponent(0.9999)).toBe('1.0');
  });
  it('keeps constructor and arity', () => {
    expect(formatColorPresentation('vec3(1.0, 0.5, 0.25)', { red: 0.2, green: 0.4, blue: 0.6, alpha: 1 })).toBe('vec3(0.2, 0.4, 0.6)');
    expect(formatColorPresentation('vec3(1.0,0.5,0.25)', { red: 0.2, green: 0.4, blue: 0.6, alpha: 0.3 })).toBe('vec3(0.2,0.4,0.6)');
    expect(formatColorPresentation('vec4(1.0, 0.5, 0.25, 1.0)', { red: 0.2, green: 0.4, blue: 0.6, alpha: 0.5 })).toBe(
      'vec4(0.2, 0.4, 0.6, 0.5)',
    );
    expect(formatColorPresentation('color3(1.0, 0.5, 0.25)', { red: 1, green: 0, blue: 0, alpha: 1 })).toBe('color3(1.0, 0.0, 0.0)');
  });
  it('keeps gray shorthand only while gray', () => {
    expect(formatColorPresentation('vec3(0.5)', { red: 0.7, green: 0.7, blue: 0.7, alpha: 1 })).toBe('vec3(0.7)');
    expect(formatColorPresentation('vec3(0.5)', { red: 0.7, green: 0.2, blue: 0.7, alpha: 1 })).toBe('vec3(0.7, 0.2, 0.7)');
  });
  it('returns a text edit', () => {
    const [p] = computeColorPresentations('vec3(0.0)', { red: 1, green: 1, blue: 1, alpha: 1 }, range);
    expect(p.label).toBe('vec3(1.0)');
    expect(p.textEdit).toEqual({ range, newText: 'vec3(1.0)' });
  });
  it('splits identifiers into words', () => {
    expect(identifierWords('skyCol_2')).toEqual(['sky', 'col']);
    expect(identifierWords('u_TINT')).toEqual(['u', 'tint']);
  });
});
