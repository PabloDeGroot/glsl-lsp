import { describe, expect, it } from 'vitest';
import { PINS_STATE_KEY, type PinAnchor, type ValueTarget } from '../shared/valuesProtocol';
import { PinStore, anchorKey, childKeyOf, mergeOptions, newPinId, pickChild, shiftAnchor, type MementoLike } from '../client/src/values/pins';
import { baseName } from '../client/src/values/rows';

class FakeMemento implements MementoLike {
  data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

const anchor = (over: Partial<PinAnchor> = {}): PinAnchor => ({
  uri: 'file:///a/noise.glsl',
  kind: 'float',
  fingerprint: 'float r = #;',
  line: 3,
  character: 10,
  ordinal: 0,
  ...over,
});

describe('PinStore', () => {
  it('adds, persists and reloads pins', async () => {
    const m = new FakeMemento();
    const s = new PinStore(m, 10_000);
    const p = s.add(anchor(), 'r', { mode: 'color' }, undefined, 123);
    await s.flush();
    expect(p.id).toMatch(/^p_[0-9a-z]{8}$/);
    const s2 = new PinStore(m);
    expect(s2.list()).toHaveLength(1);
    expect(s2.list()[0]).toMatchObject({ label: 'r', createdAt: 123, options: { mode: 'color' } });
    expect(m.get(PINS_STATE_KEY)).toBeTruthy();
  });

  it('ignores corrupt stored data', () => {
    const m = new FakeMemento();
    m.data.set(PINS_STATE_KEY, [{ nope: 1 }, null, 4]);
    expect(new PinStore(m).list()).toEqual([]);
  });

  it('removes, clears and reorders', () => {
    const s = new PinStore(new FakeMemento(), 10_000);
    const a = s.add(anchor({ ordinal: 0 }), 'a');
    const b = s.add(anchor({ ordinal: 1 }), 'b');
    const c = s.add(anchor({ ordinal: 2 }), 'c');
    s.reorder([c.id, 'unknown', a.id]);
    expect(s.list().map((p) => p.label)).toEqual(['c', 'a', 'b']);
    expect(s.remove(a.id)).toBe(true);
    expect(s.remove(a.id)).toBe(false);
    expect(s.list().map((p) => p.id)).toEqual([c.id, b.id]);
    s.clear();
    expect(s.size).toBe(0);
  });

  it('refresh updates the anchor and label', () => {
    const s = new PinStore(new FakeMemento(), 10_000);
    const p = s.add(anchor(), 'r');
    s.refresh(p.id, anchor({ line: 9 }), 'radius');
    expect(s.get(p.id)?.anchor.line).toBe(9);
    expect(s.get(p.id)?.label).toBe('radius');
  });

  it('findByAnchor dedupes by anchor key and child index', () => {
    const s = new PinStore(new FakeMemento(), 10_000);
    s.add(anchor(), 'r');
    expect(s.findByAnchor(anchor({ line: 50 }))).toBeTruthy();
    expect(s.findByAnchor(anchor(), 1)).toBeUndefined();
    expect(s.findByAnchor(anchor({ ordinal: 1 }))).toBeUndefined();
  });

  it('setOptions merges and clears undefined', () => {
    const s = new PinStore(new FakeMemento(), 10_000);
    const p = s.add(anchor(), 'r', { mode: 'vector', keepLength: true });
    s.setOptions(p.id, { keepLength: undefined, range: { min: 0, max: 2 } });
    expect(s.get(p.id)?.options).toEqual({ mode: 'vector', range: { min: 0, max: 2 } });
  });
});

describe('helpers', () => {
  it('newPinId is deterministic with a seeded random', () => {
    expect(newPinId(() => 0)).toBe('p_00000000');
  });
  it('anchorKey ignores line and character', () => {
    expect(anchorKey(anchor({ line: 1 }))).toBe(anchorKey(anchor({ line: 99 })));
  });
  it('mergeOptions', () => {
    expect(mergeOptions({ mode: 'color' }, { expanded: true })).toEqual({ mode: 'color', expanded: true });
  });
  it('baseName decodes uris', () => {
    expect(baseName('file:///c%3A/my%20dir/noise.glsl')).toBe('noise.glsl');
    expect(baseName('file:///a/b%20c.frag?x#y')).toBe('b c.frag');
  });
});

// ---------------------------------------------------------------- review regressions

const flt = (text: string, name?: string): ValueTarget =>
  ({
    id: text,
    kind: 'float',
    uri: 'u',
    version: 1,
    declKind: 'expression',
    snippet: text,
    anchor: { uri: 'u', kind: 'float', fingerprint: '', line: 0, character: 0, ordinal: 0 },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    components: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, value: Number(text), text, editable: true }],
    colorish: false,
    ...(name ? { name } : {}),
  }) as ValueTarget;

describe('child pins keep their child', () => {
  it('a literal inserted before the pinned child does not retarget it', () => {
    const before = [flt('0.5'), flt('0.3')];
    const key = childKeyOf(before, 1)!;
    const after = [flt('2.0'), flt('0.5'), flt('0.3')];
    expect(pickChild(after, 1, key)).toBe(2);
  });
  it('a value edited in place keeps the index when the structure is unchanged', () => {
    const key = childKeyOf([flt('0.5'), flt('0.3')], 1)!;
    expect(pickChild([flt('0.5'), flt('0.35')], 1, key)).toBe(1);
  });
  it('structure and value changed: stale rather than a different literal', () => {
    const key = childKeyOf([flt('0.5'), flt('0.3')], 1)!;
    expect(pickChild([flt('2.0'), flt('0.5'), flt('0.9')], 1, key)).toBe(-1);
  });
  it('identical literals: the stored position decides', () => {
    const key = childKeyOf([flt('0.5'), flt('0.5'), flt('1.0')], 1)!;
    expect(pickChild([flt('0.5'), flt('0.5'), flt('1.0')], 1, key)).toBe(1);
  });
  it('old pins without a key use the index', () => {
    expect(pickChild([flt('1.0')], 0, undefined)).toBe(0);
    expect(pickChild([flt('1.0')], 3, undefined)).toBe(-1);
  });
});

describe('pin anchors follow line edits', () => {
  const anchor = (line: number, character = 4): PinAnchor => ({ uri: 'u', kind: 'float', fingerprint: 'x = #;', line, character, ordinal: 0 });
  const ch = (sl: number, sc: number, el: number, ec: number, text: string) => ({ range: { start: { line: sl, character: sc }, end: { line: el, character: ec } }, text });
  it('lines inserted or deleted above shift the line', () => {
    expect(shiftAnchor(anchor(10), [ch(2, 0, 2, 0, 'a\nb\n')]).line).toBe(12);
    expect(shiftAnchor(anchor(10), [ch(2, 0, 5, 0, '')]).line).toBe(7);
  });
  it('edits below or on the same line after the target change nothing', () => {
    const a = anchor(10);
    expect(shiftAnchor(a, [ch(12, 0, 12, 0, 'x\n')])).toBe(a);
    expect(shiftAnchor(a, [ch(10, 8, 10, 9, '7')])).toBe(a);
  });
  it('a newline typed before the target on its line moves line and column', () => {
    expect(shiftAnchor(anchor(10, 6), [ch(10, 2, 10, 2, '\n  ')])).toMatchObject({ line: 11, character: 6 });
  });
  it('removing the pinned line marks the anchor strict (a neighbour must not take its place)', () => {
    const r = shiftAnchor(anchor(10), [ch(10, 0, 11, 0, '')]);
    expect(r.strict).toBe(true);
    // editing the value on its line is not a removal
    expect(shiftAnchor(anchor(10), [ch(10, 4, 10, 7, '0.75')]).strict).toBeUndefined();
  });
  it('PinStore.shiftLines applies to the pins of that document only', () => {
    const s = new PinStore(new FakeMemento(), 0);
    const p = s.add(anchor(10), 'x');
    const q = s.add({ ...anchor(10), uri: 'other' }, 'y');
    s.shiftLines('u', [ch(0, 0, 0, 0, '\n\n')]);
    expect(s.get(p.id)!.anchor.line).toBe(12);
    expect(s.get(q.id)!.anchor.line).toBe(10);
  });
});
