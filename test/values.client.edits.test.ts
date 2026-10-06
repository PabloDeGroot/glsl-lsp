// EditApplier against the in-memory vscode mock (test/mocks/vscode.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { EditApplier } from '../client/src/values/edits';
import type { TargetLike } from '../client/src/values/editText';
import { DOC_URI, getText, setText, userEdit } from './mocks/vscode';

const tick = () => new Promise((r) => setTimeout(r, 5));

/** Float target for the literal `lit` (n-th occurrence) in `line` (single-line document). */
function floatAt(line: string, lit: string, nth = 0): TargetLike {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = line.indexOf(lit, i + 1);
  const range = { start: { line: 0, character: i }, end: { line: 0, character: i + lit.length } };
  return { kind: 'float', range, components: [{ range, value: Number(lit), text: lit, editable: true }] };
}

describe('EditApplier', () => {
  let ap: EditApplier;
  beforeEach(() => {
    ap?.dispose();
    ap = new EditApplier({ maxDecimals: () => 4 });
  });

  it('rejects a stale target whose literal grew (0.5 -> 0.55) instead of writing 0.75', async () => {
    setText('float a = 0.5;');
    const stale = floatAt('float a = 0.5;', '0.5');
    setText('float a = 0.55;');
    expect(await ap.once(DOC_URI, stale, [0.7], 1)).toBe('The value changed in the editor');
    expect(getText()).toBe('float a = 0.55;');
  });

  it('two live gestures on one line shift each other (no corruption)', async () => {
    const line = 'float d = smoothstep(0.1, 0.25, x);';
    setText(line);
    const A = floatAt(line, '0.25');
    const B = floatAt(line, '0.1');
    expect(await ap.begin(1, DOC_URI, A)).toBeUndefined();
    ap.update(1, [0.26], 2);
    await tick();
    expect(await ap.begin(2, DOC_URI, B)).toBeUndefined();
    ap.update(2, [0.123], 3);
    await tick();
    await ap.end(2, true);
    await ap.end(1, true);
    expect(getText()).toBe('float d = smoothstep(0.123, 0.26, x);');
  });

  it('a one-shot edit before a live gesture shifts it', async () => {
    const line = 'vec2 p = vec2(0.5, 1.0);';
    setText(line);
    expect(await ap.begin(1, DOC_URI, floatAt(line, '1.0'))).toBeUndefined();
    ap.update(1, [1.5], 1);
    await tick();
    expect(await ap.once(DOC_URI, floatAt(getText(), '0.5'), [0.125], 3)).toBeUndefined();
    ap.update(1, [1.75], 2);
    await tick();
    await ap.end(1, true);
    expect(getText()).toBe('vec2 p = vec2(0.125, 1.75);');
  });

  it('user typing before a gesture shifts it; typing inside aborts it', async () => {
    setText('x = 0.5;');
    const aborted: number[] = [];
    ap.onAborted = (id) => aborted.push(id);
    expect(await ap.begin(1, DOC_URI, floatAt('x = 0.5;', '0.5'))).toBeUndefined();
    userEdit(0, 0, 'float ');
    ap.update(1, [0.75], 2);
    await tick();
    expect(getText()).toBe('float x = 0.75;');
    userEdit(11, 11, '9');
    expect(aborted).toEqual([1]);
  });

  it('reports the end of a gesture that wrote nothing (deferred queries are released)', async () => {
    setText('x = 0.5;');
    const ended: string[] = [];
    const edited: string[] = [];
    ap.onDidEnd = (u) => ended.push(u);
    ap.onDidEdit = (u) => edited.push(u);
    expect(await ap.begin(7, DOC_URI, floatAt('x = 0.5;', '0.5'))).toBeUndefined();
    ap.update(7, [0.5], 1); // same value: nothing is written
    await ap.end(7, true);
    expect(edited).toEqual([]);
    expect(ended).toEqual([DOC_URI]);
    expect(ap.activeUris().size).toBe(0);
  });

  it('endAll closes orphaned gestures (webview re-created) and keeps what they wrote', async () => {
    setText('x = 0.5;');
    expect(await ap.begin(1, DOC_URI, floatAt('x = 0.5;', '0.5'))).toBeUndefined();
    ap.update(1, [0.8], 1);
    await tick();
    await ap.endAll();
    expect(ap.active).toBe(false);
    expect(getText()).toBe('x = 0.8;');
  });
});
