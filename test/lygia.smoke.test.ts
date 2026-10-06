// Parses every LYGIA .glsl file (if the library sits next to this repo, as in
// the parent shader workspace) and checks the parser never throws and stays fast.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '../server/src/core/parser';

const LYGIA = resolve(__dirname, '..', '..', 'lygia');

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (name.endsWith('.glsl')) out.push(full);
  }
  return out;
}

describe.skipIf(!existsSync(LYGIA))('LYGIA smoke test', () => {
  it('parses every .glsl file without throwing', () => {
    const files = collect(LYGIA);
    expect(files.length).toBeGreaterThan(100);
    const t0 = performance.now();
    let functions = 0;
    let undocumented = 0;
    let internalErrors = 0;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const model = parse(text, 'file:///' + f.replace(/\\/g, '/'));
      functions += model.functions.length;
      undocumented += model.functions.filter((fn) => !fn.doc).length;
      internalErrors += model.issues.filter((i) => i.message.startsWith('internal')).length;
    }
    const ms = performance.now() - t0;
    console.log(`LYGIA: ${files.length} files, ${functions} functions (${undocumented} without docs) parsed in ${ms.toFixed(0)} ms`);
    expect(internalErrors).toBe(0);
    expect(functions).toBeGreaterThan(500);
    expect(ms).toBeLessThan(10_000);
  });

  it('documents gnoise from the file-level YAML block', () => {
    const file = join(LYGIA, 'generative', 'gnoise.glsl');
    const model = parse(readFileSync(file, 'utf8'), 'file:///gnoise.glsl');
    const fns = model.functions.filter((f) => f.name === 'gnoise');
    expect(fns.length).toBeGreaterThanOrEqual(4);
    expect(fns[0].doc?.style).toBe('yaml');
    expect(fns[0].doc?.yaml?.values['description']).toBe('Gradient Noise');
    expect(model.includes.map((i) => i.path)).toContain('../math/cubic.glsl');
  });
});
