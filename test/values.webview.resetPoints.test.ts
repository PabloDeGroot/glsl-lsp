import { describe, expect, it } from 'vitest';
import type { ValueTarget } from '../shared/valuesProtocol';
import { differsFrom, ResetPoints } from '../webview/src/math/resetPoints';

const f = (value: number, id = 'float:3:10', uri = 'file:///a.glsl'): ValueTarget =>
  ({
    id,
    kind: 'float',
    uri,
    version: 1,
    declKind: 'local',
    snippet: String(value),
    anchor: { uri, kind: 'float', fingerprint: '', line: 3, character: 10, ordinal: 0 },
    range: { start: { line: 3, character: 10 }, end: { line: 3, character: 13 } },
    components: [{ range: { start: { line: 3, character: 10 }, end: { line: 3, character: 13 } }, value, text: String(value), editable: true }],
    colorish: false,
  }) as ValueTarget;

describe('ResetPoints', () => {
  it('captures once per target, not per widget instance', () => {
    const r = new ResetPoints();
    expect(r.capture(f(0.5))).toEqual([0.5]);
    // edited, then the widget is rebuilt (cursor -> pin, mode switch): the reset point stays.
    expect(r.capture(f(0.8))).toEqual([0.5]);
    expect(r.capture(f(0.9))).toEqual([0.5]);
    // another target has its own.
    expect(r.capture(f(2, 'float:9:1'))).toEqual([2]);
    expect(r.capture(f(2, 'float:3:10', 'file:///b.glsl'))).toEqual([2]);
  });

  it('follows a target whose id moved', () => {
    const r = new ResetPoints();
    const a = f(0.5);
    r.capture(a);
    const moved = f(0.7, 'float:4:10');
    r.follow(a, moved);
    expect(r.capture(moved)).toEqual([0.5]);
  });

  it('evicts the oldest beyond the cap', () => {
    const r = new ResetPoints(2);
    r.capture(f(1, 'a'));
    r.capture(f(2, 'b'));
    r.capture(f(3, 'c'));
    expect(r.get(f(0, 'a'))).toBeUndefined();
    expect(r.get(f(0, 'c'))).toEqual([3]);
  });

  it('hides the reset link while the value equals the reset point', () => {
    expect(differsFrom(0.5, 0.5)).toBe(false);
    expect(differsFrom(0.5 + 1e-12, 0.5)).toBe(false);
    expect(differsFrom(0.51, 0.5)).toBe(true);
    expect(differsFrom(0.5, undefined)).toBe(false);
  });
});
