import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings, SettingsStore } from '../server/src/settings';

/** Flattens `{ a: { b: 1 } }` to `{ 'a.b': 1 }` (arrays are leaves). */
function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v as Record<string, unknown>, `${prefix}${k}.`));
    else out[prefix + k] = v;
  }
  return out;
}

describe('settings', () => {
  it('package.json contributes exactly the settings the server knows, with the same defaults', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const props = pkg.contributes.configuration.properties as Record<string, { default: unknown }>;
    const contributed = Object.fromEntries(Object.entries(props).map(([k, v]) => [k.replace(/^glslLsp\./, ''), v.default]));
    expect(contributed).toEqual(flatten(defaultSettings as unknown as Record<string, unknown>));
  });

  it('merges partial settings over the defaults and drops values of the wrong type', () => {
    const store = new SettingsStore();
    store.update({ diagnostics: { glslang: { path: 'C:/bin/glslangValidator.exe' }, onType: 'yes' }, includePaths: ['lib'] });
    const s = store.get();
    expect(s.diagnostics.glslang).toEqual({ enable: true, path: 'C:/bin/glslangValidator.exe' });
    expect(s.diagnostics.onType).toBe(true);
    expect(s.includePaths).toEqual(['lib']);
  });

  it('maps legacy booleans and rejects unknown enum values', () => {
    const store = new SettingsStore();
    store.update({ inlayHints: { parameterNames: false }, colors: { mode: 'rainbow' } });
    expect(store.get().inlayHints.parameterNames).toBe('none');
    expect(store.get().colors.mode).toBe('heuristic');
    store.update({ inlayHints: { parameterNames: true }, colors: { mode: 'all' } });
    expect(store.get().inlayHints.parameterNames).toBe('literals');
    expect(store.get().colors.mode).toBe('all');
  });

  it('notifies listeners with the previous value', () => {
    const store = new SettingsStore();
    const seen: string[] = [];
    store.onDidChange((s, prev) => seen.push(`${prev.colors.mode}->${s.colors.mode}`));
    store.update({ colors: { mode: 'off' } });
    expect(seen).toEqual(['heuristic->off']);
  });
});
