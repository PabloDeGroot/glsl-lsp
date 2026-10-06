import { describe, expect, it } from 'vitest';
import { nudgeFallback, nudgeLine, nudgeLiteral, numberAt, planNudge } from '../client/src/values/nudgeCore';

const apply = (line: string, col: number, dir: 1 | -1 = 1, mult = 1) => {
  const r = nudgeLine(line, col, dir, mult);
  return r ? line.slice(0, r.start) + r.newText + line.slice(r.end) : undefined;
};

describe('nudgeLiteral', () => {
  it('uses the last decimal as step and keeps the decimals', () => {
    expect(nudgeLiteral('0.25', false, 1)).toBe('0.26');
    expect(nudgeLiteral('1.0', false, 1)).toBe('1.1');
    expect(nudgeLiteral('0.9', false, 1)).toBe('1.0');
    expect(nudgeLiteral('1.250', false, -1)).toBe('1.249');
    expect(nudgeLiteral('2.', false, 1)).toBe('2.1');
  });
  it('large variant is x10', () => {
    expect(nudgeLiteral('1.0', false, 1, 10)).toBe('2.0');
    expect(nudgeLiteral('0.25', false, -1, 10)).toBe('0.15');
  });
  it('integers step by 1', () => {
    expect(nudgeLiteral('3', true, 1)).toBe('4');
    expect(nudgeLiteral('0', true, -1)).toBe('-1');
    expect(nudgeLiteral('3', true, 1, 10)).toBe('13');
  });
  it('negatives and zero crossing', () => {
    expect(nudgeLiteral('-0.5', false, 1)).toBe('-0.4');
    expect(nudgeLiteral('0.1', false, -1)).toBe('0.0');
    expect(nudgeLiteral('0.0', false, -1)).toBe('-0.1');
    expect(nudgeLiteral('-0.1', false, 1)).toBe('0.0');
  });
  it('has no float noise', () => {
    expect(nudgeLiteral('0.7', false, 1)).toBe('0.8');
    expect(nudgeLiteral('0.3', false, 1)).toBe('0.4');
  });
});

describe('numberAt / nudgeLine', () => {
  it('finds the literal under or next to the cursor', () => {
    const line = 'vec3 c = vec3(1.0, 0.5, 0.25);';
    const i = line.indexOf('0.5');
    expect(apply(line, i + 1)).toBe('vec3 c = vec3(1.0, 0.6, 0.25);');
    expect(apply(line, i)).toBe('vec3 c = vec3(1.0, 0.6, 0.25);');
    expect(apply(line, i + 3)).toBe('vec3 c = vec3(1.0, 0.6, 0.25);');
  });
  it('includes a unary minus but not a binary one', () => {
    expect(apply('x = -0.5;', 6)).toBe('x = -0.4;');
    expect(apply('x = y - 0.5;', 9)).toBe('x = y - 0.6;');
    expect(apply('f(a, -2.0)', 6)).toBe('f(a, -1.9)');
    expect(apply('return -1.0;', 9)).toBe('return -0.9;');
  });
  it('goes further negative on negative numbers', () => {
    expect(apply('x = -0.5;', 6, -1)).toBe('x = -0.6;');
  });
  it('ignores identifiers with digits, comments and non-numbers', () => {
    expect(numberAt('float a1 = 2.0;', 7)).toBeUndefined();
    expect(numberAt('x = 1.0; // 2.0', 13)).toBeUndefined();
    expect(numberAt('vec3 a;', 3)).toBeUndefined();
  });
  it('keeps suffixes and handles integers', () => {
    expect(apply('x = 1.5f;', 5)).toBe('x = 1.6f;');
    expect(apply('for (int i = 0; i < 8; i++)', 'for (int i = 0; i < 8'.length)).toBe('for (int i = 0; i < 9; i++)');
  });
  it('prefers the literal the cursor is inside when two touch', () => {
    expect(apply('vec2(1.0,2.0)', 10)).toBe('vec2(1.0,2.1)');
  });
});

describe('nudge after a binary operator (regression)', () => {
  const apply = (line: string, ch: number, dir: 1 | -1, mul = 1) => {
    const r = nudgeLine(line, ch, dir, mul)!;
    return line.slice(0, r.start) + r.newText + line.slice(r.end);
  };
  it('never writes the decrement operator', () => {
    expect(apply('float x = 1.0-0.5;', 15, -1, 10)).toBe('float x = 1.0- -0.5;');
    expect(apply('int i = n-0;', 10, -1)).toBe('int i = n- -1;');
    expect(apply('float y = uv.x-0.0;', 16, -1)).toBe('float y = uv.x- -0.1;');
    expect(apply('float y = x+0.0;', 13, -1)).toBe('float y = x+ -0.1;');
  });
  it('spaced operators and unary minus are unchanged', () => {
    expect(apply('float y = x - 0.0;', 15, -1)).toBe('float y = x - -0.1;');
    expect(apply('vec2(-0.1, 1.0)', 7, 1)).toBe('vec2(0.0, 1.0)');
    expect(apply('float x = 1.0- -0.5;', 17, 1, 10)).toBe('float x = 1.0- 0.5;');
  });
});

describe('planNudge / nudgeFallback (multi-cursor and platform keys)', () => {
  const cur = (line: number, text: string, character: number) => ({ line, text, character });
  it('single cursor on a number nudges; off a number falls back', () => {
    expect(planNudge([cur(0, 'x = 0.5;', 5)], 1)).toEqual([{ line: 0, start: 4, end: 7, newText: '0.6' }]);
    expect(planNudge([cur(0, 'x = y;', 4)], 1)).toBeUndefined();
  });
  it('several cursors nudge only when every cursor is on a number', () => {
    const all = planNudge([cur(0, 'a = 0.5;', 5), cur(1, 'b = 1.0;', 5)], 1);
    expect(all?.map((e) => e.newText)).toEqual(['0.6', '1.1']);
    // Add Cursor Below / column selection passing over a line without a number: keep adding cursors.
    expect(planNudge([cur(0, 'a = 0.5;', 5), cur(1, '  // nothing', 5)], 1)).toBeUndefined();
    expect(planNudge([cur(0, 'a = 0.5;', 5), cur(1, 'b = c;', 5)], -1)).toBeUndefined();
  });
  it('two cursors on the same literal edit it once', () => {
    expect(planNudge([cur(0, 'a = 0.5;', 4), cur(0, 'a = 0.5;', 6)], 1)).toHaveLength(1);
  });
  it('falls back to the platform default of the key', () => {
    expect(nudgeFallback('win32', 'up')).toBe('editor.action.insertCursorAbove');
    expect(nudgeFallback('win32', 'down')).toBe('editor.action.insertCursorBelow');
    expect(nudgeFallback('win32', 'upLarge')).toBe('cursorColumnSelectUp');
    // Linux: Ctrl+Alt+Up/Down is not Add Cursor (that is Shift+Alt+Up/Down).
    expect(nudgeFallback('linux', 'up')).toBeUndefined();
    expect(nudgeFallback('linux', 'down')).toBeUndefined();
    expect(nudgeFallback('linux', 'downLarge')).toBe('cursorColumnSelectDown');
    expect(nudgeFallback('darwin', 'up')).toBeUndefined();
    expect(nudgeFallback('darwin', 'upLarge')).toBeUndefined();
  });
});
