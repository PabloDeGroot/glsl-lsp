import { describe, expect, it } from 'vitest';
import {
  computeDeclaration,
  computeDefinition,
  computeDocumentLinks,
  computeDocumentSymbols,
  computeHighlights,
  computePrepareRename,
  computeReferences,
  computeRename,
  computeTypeDefinition,
  computeWorkspaceSymbols,
  fuzzyScore,
} from '../server/src/features/navigation';
import { makeWorkspace, posOf, uri } from './helpers';

const LIB = `struct Light { vec3 pos; float power; };
float f(float x);
float f(float x) { return x; }
float f(float x, float y) { return x + y; }
#define SQ(x) ((x)*(x))
#ifndef FNC_G
#define FNC_G
#endif
const float K = 2.0;
`;

const MAIN = `#include "lib.glsl"
#iChannel0 "file://tex/a.png"
void other() { float p = 1.0; p += 2.0; }
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    Light l;
    float p = f(1.0, 2.0) + f(3.0) + K + SQ(2.0);
    l.pos = vec3(p);
    fragColor = vec4(p);
}
`;

const files = { 'main.glsl': MAIN, 'lib.glsl': LIB, 'other.glsl': 'float f(float q) { return q; }\n' };
const U = uri('main.glsl');

describe('navigation', () => {
  const { ws } = makeWorkspace(files);

  it('definition picks the overload matching the argument count', () => {
    const two = computeDefinition(ws, U, posOf(MAIN, 'f(1.0, 2.0)', 0));
    expect(two).toHaveLength(1);
    expect(two[0].uri).toBe(uri('lib.glsl'));
    expect(two[0].range.start.line).toBe(3);
    const one = computeDefinition(ws, U, posOf(MAIN, 'f(3.0)', 0));
    expect(one.map((l) => l.range.start.line)).toEqual([2]);
  });

  it('declaration prefers the prototype', () => {
    const d = computeDeclaration(ws, U, posOf(MAIN, 'f(3.0)', 0));
    expect(d.map((l) => l.range.start.line)).toEqual([1]);
  });

  it('definition of macros, consts, locals, include paths', () => {
    expect(computeDefinition(ws, U, posOf(MAIN, 'SQ(2', 0))[0].uri).toBe(uri('lib.glsl'));
    expect(computeDefinition(ws, U, posOf(MAIN, 'K +', 0))[0].range.start.line).toBe(8);
    const p = computeDefinition(ws, U, posOf(MAIN, 'p);', 0));
    expect(p[0].uri).toBe(U);
    expect(p[0].range.start.line).toBe(5);
    const inc = computeDefinition(ws, U, posOf(MAIN, 'lib.glsl', 1));
    expect(inc[0].uri).toBe(uri('lib.glsl'));
  });

  it('definition of a field and typeDefinition of a variable', () => {
    const fld = computeDefinition(ws, U, posOf(MAIN, 'pos =', 1));
    expect(fld[0].uri).toBe(uri('lib.glsl'));
    expect(fld[0].range.start.line).toBe(0);
    const td = computeTypeDefinition(ws, U, posOf(MAIN, 'l.pos', 0));
    expect(td).toHaveLength(1);
    expect(td[0].uri).toBe(uri('lib.glsl'));
  });

  it('builtins have no definition', () => {
    expect(computeDefinition(ws, U, posOf(MAIN, 'vec4(p)', 1))).toEqual([]);
  });

  it('references are scope-correct', () => {
    const refs = computeReferences(ws, U, posOf(MAIN, 'p);', 0), true);
    expect(refs.every((r) => r.uri === U)).toBe(true);
    expect(refs.every((r) => r.range.start.line >= 4)).toBe(true);
    expect(refs.length).toBe(3);
    const noDecl = computeReferences(ws, U, posOf(MAIN, 'p);', 0), false);
    expect(noDecl.length).toBe(2);
  });

  it('references of a global span files', () => {
    const refs = computeReferences(ws, U, posOf(MAIN, 'K +', 0), true);
    expect(refs.map((r) => r.uri).sort()).toEqual([U, uri('lib.glsl')].sort());
  });

  it('highlight marks writes and reads', () => {
    const h = computeHighlights(ws, U, posOf(MAIN, 'p);', 0));
    expect(h.length).toBe(3);
    expect(h.filter((x) => x.kind === 3)).toHaveLength(1);
  });

  it('rename edits every reference across files, not shadowed locals', () => {
    const edit = computeRename(ws, U, posOf(MAIN, 'K +', 0), 'KK')!;
    expect(Object.keys(edit.changes!).length).toBe(2);
    const local = computeRename(ws, U, posOf(MAIN, 'p);', 0), 'q')!;
    expect(Object.values(local.changes!).flat().length).toBe(3);
    expect(local.changes![U].every((e) => e.range.start.line >= 4)).toBe(true);
  });

  it('rename refuses builtins, keywords and bad names', () => {
    expect(computePrepareRename(ws, U, posOf(MAIN, 'vec4(p)', 1))).toEqual({ error: expect.stringMatching(/builtin/) });
    expect((computePrepareRename(ws, U, posOf(MAIN, 'K +', 0)) as { placeholder: string }).placeholder).toBe('K');
    expect(computeRename(ws, U, posOf(MAIN, 'K +', 0), 'float')).toBeNull();
    expect(computeRename(ws, U, posOf(MAIN, 'K +', 0), '1x')).toBeNull();
  });

  it('document symbols are hierarchical and skip guards', () => {
    const syms = computeDocumentSymbols(ws, uri('lib.glsl'));
    const names = syms.map((s) => s.name);
    expect(names).toContain('Light');
    expect(names).toContain('SQ');
    expect(names).not.toContain('FNC_G');
    const light = syms.find((s) => s.name === 'Light')!;
    expect(light.children!.map((c) => c.name)).toEqual(['pos', 'power']);
    expect(syms.find((s) => s.name === 'K')!.kind).toBe(14);
  });

  it('workspace symbols are fuzzy and capped', () => {
    const r = computeWorkspaceSymbols(ws, 'mimg');
    expect(r.map((s) => s.name)).toContain('mainImage');
    expect(computeWorkspaceSymbols(ws, 'Light')[0].name).toBe('Light');
    expect(computeWorkspaceSymbols(ws, 'Light')[0].containerName).toBe('lib.glsl');
    const many: Record<string, string> = {};
    for (let i = 0; i < 300; i++) many[`f${i}.glsl`] = `float fn${i}() { return 0.0; }\n`;
    expect(computeWorkspaceSymbols(makeWorkspace(many).ws, 'fn').length).toBe(200);
    expect(fuzzyScore('abc', 'xyz')).toBe(-1);
  });

  it('document links for includes and channel files', () => {
    const links = computeDocumentLinks(ws, U);
    const inc = links.find((l) => l.target === uri('lib.glsl'))!;
    expect(inc.tooltip).toBe('lib.glsl');
    expect(inc.range.start.line).toBe(0);
    expect(links.length).toBeGreaterThanOrEqual(1);
  });

  it('does not throw on half-typed code', () => {
    const { ws: w } = makeWorkspace({ 'a.glsl': 'float g(float x) { return x; }\nvoid h() { g( ; float q = \n' });
    const u = uri('a.glsl');
    expect(() => {
      computeDefinition(w, u, { line: 1, character: 12 });
      computeReferences(w, u, { line: 1, character: 12 }, true);
      computeDocumentSymbols(w, u);
    }).not.toThrow();
  });
});
