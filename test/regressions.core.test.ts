// Regression tests for parser / resolution defects found in review.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getBuiltins } from '../server/src/builtins';
import { fsPathToUri, NodeFileSystem, optionDescription, parse, parseYamlDoc, typeOfOccurrence, Workspace, yamlToMarkdown } from '../server/src/core';
import { computeFastDiagnostics } from '../server/src/features/diagnostics';
import { computeHover } from '../server/src/features/hover';
import { computeRename } from '../server/src/features/navigation';
import { makeWorkspace, parseText, posOf, uri } from './helpers';

const U = uri('main.glsl');
const refs = (ws: ReturnType<typeof makeWorkspace>['ws'], text: string, needle: string, delta = 0, nth = 0, path = 'main.glsl') =>
  ws
    .findReferences(uri(path), posOf(text, needle, delta, nth), true)
    .map((r) => `${r.uri.slice(uri('').length)}@${r.range.start.line}:${r.range.start.character}`)
    .sort();

describe('references', () => {
  it('finds bare uses of instance-less interface block fields (and macro bodies)', () => {
    const text = 'uniform Blk { float tval; vec3 bdir; };\n#define TV tval\nvoid main(){ float t = tval + 1.0; }';
    const { ws } = makeWorkspace({ 'main.glsl': text });
    const fromDecl = refs(ws, text, 'tval;');
    expect(fromDecl).toEqual(['main.glsl@0:20', 'main.glsl@1:11', 'main.glsl@2:23']);
    expect(refs(ws, text, 'tval +')).toEqual(fromDecl);
    const edit = computeRename(ws, U, posOf(text, 'tval +'), 'gain');
    expect(edit?.changes?.[U]).toHaveLength(3);
  });

  it('does not bind `.member` in a #define body to a global of the same name', () => {
    const text = 'uniform float time;\nstruct Ray { vec3 dir; float time; };\n#define GETT(r) r.time\nfloat f(Ray r){ return r.time + time; }';
    const { ws } = makeWorkspace({ 'main.glsl': text });
    expect(refs(ws, text, 'time;')).toEqual(['main.glsl@0:14', 'main.glsl@3:32']);
  });

  it('a local initializer that reads a shadowed name refers to the outer variable', () => {
    const text = 'float x = 1.0;\nvoid main(){ float x = x + 1.0; }';
    const { ws } = makeWorkspace({ 'main.glsl': text });
    expect(refs(ws, text, 'x = 1.0')).toEqual(['main.glsl@0:6', 'main.glsl@1:23']);
    expect(refs(ws, text, 'x = x')).toEqual(['main.glsl@1:19']);
    const t2 = 'void main(){\n float d = 1.0;\n { float d = d * 2.0; }\n}\n';
    const w2 = makeWorkspace({ 'main.glsl': t2 }).ws;
    expect(refs(w2, t2, 'd = 1.0')).toEqual(['main.glsl@1:7', 'main.glsl@2:13']);
  });

  it('local structs of the same name in different functions are different symbols', () => {
    const text = 'float f(){ struct L { float v; }; L l; l.v = 1.0; return l.v; }\nfloat h(){ struct L { float v; }; L l; l.v = 2.0; return l.v; }';
    const { ws } = makeWorkspace({ 'main.glsl': text });
    expect(refs(ws, text, 'L {')).toEqual(['main.glsl@0:18', 'main.glsl@0:34']);
    expect(refs(ws, text, 'v;')).toEqual(['main.glsl@0:41', 'main.glsl@0:59', 'main.glsl@0:28'].sort());
  });

  it('renames overloads split across an includer and an included file consistently', () => {
    const files = {
      'pal.glsl': 'vec3 palette(in float t, in vec3 a, in vec3 b, in vec3 c, in vec3 d) { return a; }\n',
      'lib.glsl': '#include "pal.glsl"\nvec3 palette(float t) { return palette(t, vec3(0), vec3(0), vec3(0), vec3(0)); }\n',
      'main.glsl': '#include "lib.glsl"\nvoid main(){ vec3 c = palette(0.3); }\n',
    };
    const { ws } = makeWorkspace(files);
    const r = refs(ws, files['pal.glsl'], 'palette', 0, 0, 'pal.glsl');
    expect(r).toEqual(['lib.glsl@1:31', 'lib.glsl@1:5', 'main.glsl@1:22', 'pal.glsl@0:5']);
  });
});

describe('parser recovery', () => {
  it('an unterminated body does not swallow uniforms, structs and consts', () => {
    const m = parseText(
      'void main() {\n  float a = 1.;\n  if (a > 0.) {\nuniform float uTime;\nstruct Light { vec3 pos; };\nconst float PI = 3.14;\nvec3 shade(Light l) { return l.pos * uTime * PI; }',
    );
    expect(m.functions.map((f) => f.name)).toEqual(['main', 'shade']);
    expect(m.structs.map((s) => s.name)).toEqual(['Light']);
    expect(m.globals.map((g) => g.name)).toEqual(['uTime', 'PI']);
    const { ws } = makeWorkspace({ 'main.glsl': m.text });
    const msgs = computeFastDiagnostics(ws, U).map((d) => d.message);
    expect(msgs.filter((x) => /Undeclared/.test(x))).toEqual([]);
  });

  it('a local struct and const inside a closed body stay local', () => {
    const m = parseText('void main() {\nconst float K = 1.0;\nstruct S { float a; };\n}\n');
    expect(m.globals).toEqual([]);
    expect(m.structs).toEqual([]);
  });

  it('macro qualifiers before a function after an unclosed body', () => {
    const m = parseText('void main(){\n float a=1.;\nHIGHP float f(HIGHP vec2 p){return p.x;}\nfloat g(){return 1.;}');
    expect(m.functions.map((f) => f.name)).toEqual(['main', 'f', 'g']);
  });

  it('an unclosed struct, block or parameter list does not absorb the next function', () => {
    const a = parseText('struct S {\n  float a;\nfloat g(){return 1.;}\nfloat h(){return 1.;}');
    expect(a.structs[0].fields.map((f) => f.name)).toEqual(['a']);
    expect(a.functions.map((f) => f.name)).toEqual(['g', 'h']);
    const b = parseText('uniform B {\n  float a;\nfloat g(){return 1.;}\nfloat h(){return 1.;}');
    expect(b.functions.map((f) => f.name)).toEqual(['g', 'h']);
    const c = parseText('float f(float a, \nfloat g(){return 1.;}\nfloat h(){return 1.;}');
    expect(c.functions.map((f) => f.name)).toEqual(['f', 'g', 'h']);
    expect(c.functions[0].params.map((p) => p.name)).toEqual(['a']);
  });

  it('nested brace-sharing conditionals do not drop a balanced outer #else', () => {
    const m = parseText(
      '#ifdef OUTER\nfloat f(float x) {\n#ifdef FAST\n    for (int i = 0; i < 2; i++) {\n#else\n    for (int i = 0; i < 8; i++) {\n#endif\n        x *= 0.5;\n    }\n    return x;\n}\n#else\nfloat f(float x) { return x; }\nfloat g(float x) { return x * 2.0; }\n#endif',
    );
    expect(m.functions.map((f) => f.name)).toEqual(['f', 'f', 'g']);
  });
});

describe('types', () => {
  const typeAt = (text: string, needle: string, delta = 0) => {
    const { ws } = makeWorkspace({ 'main.glsl': text });
    const model = ws.getModel(U)!;
    const off = model.lines.offsetAt(posOf(text, needle, delta));
    const idx = model.occurrences.findIndex((o) => o.start <= off && off <= o.end);
    return typeOfOccurrence(ws, model, idx)?.name;
  };

  it('members of an indexed matrix/vector and of constructor calls', () => {
    const t = 'mat3 m; vec3 v; mat2x4 r; void main(){ float a = m[0].x; float b = vec3(1.0).y; vec2 c = vec4(1.0).xy; vec4 d = r[1].xyzw; }';
    expect(typeAt(t, '.x;', 1)).toBe('float');
    expect(typeAt(t, '.y;', 1)).toBe('float');
    expect(typeAt(t, '.xy;', 1)).toBe('vec2');
    expect(typeAt(t, '.xyzw', 1)).toBe('vec4');
  });

  it('generic builtin return types become concrete', () => {
    const t = 'uniform sampler2D s; uniform isampler2D si; void main(){ vec3 a; vec2 uv; vec3 n = normalize(a).xyz; vec4 c = texture(s, uv).rgba; ivec4 i = texture(si, uv).rgba; float m = mix(uv, uv, 0.5).x; bvec3 q = lessThan(a, a).xyz; }';
    expect(typeAt(t, 'normalize', 1)).toBe('vec3');
    expect(typeAt(t, 'texture(s', 1)).toBe('vec4');
    expect(typeAt(t, 'texture(si', 1)).toBe('ivec4');
    expect(typeAt(t, '.rgba; ivec4', 1)).toBe('vec4');
    expect(typeAt(t, 'mix', 1)).toBe('vec2');
    expect(typeAt(t, 'lessThan', 1)).toBe('bvec3');
  });

  it('hover works on a swizzle of a constructor', () => {
    const t = 'void main(){ float b = vec3(1.0).y; }';
    const { ws } = makeWorkspace({ 'main.glsl': t });
    expect(computeHover({ workspace: ws } as never, { textDocument: { uri: U }, position: posOf(t, '.y', 1) })).not.toBeNull();
  });
});

describe('docs', () => {
  it('a same-line trailing comment documents only the last declaration', () => {
    const m = parseText('uniform vec3 col; uniform float t; // time in seconds\nvoid main(){ float a = 1.0; float b = 2.0; // b is the blend\n}\nfloat p, q; // both');
    const doc = (n: string) => [...m.globals, ...m.rootScope.children.flatMap((s) => s.symbols)].find((s) => s.name === n)?.doc?.text;
    expect(doc('col')).toBeUndefined();
    expect(doc('t')).toBe('time in seconds');
    expect(doc('a')).toBeUndefined();
    expect(doc('b')).toBe('b is the blend');
    expect(doc('p')).toBe('both');
    expect(doc('q')).toBe('both');
  });

  it('LYGIA options with a parameter list match their macro', () => {
    const yaml = parseYamlDoc('description: stretch\noptions:\n    - STRETCH_SAMPLER_FNC(TEX, UV): function used to sample the input texture\n    - STRETCH_TYPE: return type, defaults to vec4\n');
    expect(optionDescription(yaml, 'STRETCH_SAMPLER_FNC')).toBe('function used to sample the input texture');
    expect(yamlToMarkdown(yaml)).toContain('- `STRETCH_SAMPLER_FNC(TEX, UV)`: function used');
    const m = parse(
      '/*\ndescription: stretch\noptions:\n    - STRETCH_SAMPLER_FNC(TEX, UV): function used to sample\n*/\n#ifndef STRETCH_SAMPLER_FNC\n#define STRETCH_SAMPLER_FNC(TEX, UV) texture(TEX, UV)\n#endif\n',
      uri('s.glsl'),
    );
    expect(m.macros[0].doc?.text).toBe('Option of this file. function used to sample');
  });
});

describe('include case on case-insensitive file systems', () => {
  const fs = new NodeFileSystem();
  it.skipIf(!fs.caseInsensitive)('resolves to the indexed model, not a second spelling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glsllsp-case-'));
    try {
      mkdirSync(join(dir, 'My Lib'));
      mkdirSync(join(dir, 'main'));
      writeFileSync(join(dir, 'My Lib', 'Helper.glsl'), 'float helper(float x) { return x; }\n');
      const a = '#include "../my lib/helper.glsl"\nvoid main(){ float y = helper(1.0) + helper2(1.0); }\n';
      writeFileSync(join(dir, 'main', 'a.glsl'), a);
      const ws = new Workspace({ fs, builtins: getBuiltins(), roots: [fsPathToUri(dir)] });
      ws.indexWorkspaceSync();
      const helperUri = fsPathToUri(join(dir, 'My Lib', 'Helper.glsl'));
      ws.openDocument(helperUri, 'float helper(float x) { return x; }\nfloat helper2(float x) { return x; }\n');
      const aUri = fsPathToUri(join(dir, 'main', 'a.glsl'));
      expect(ws.transitiveIncludes(aUri)).toEqual([helperUri]);
      expect(ws.lookupGlobal('helper')).toHaveLength(1);
      expect(computeFastDiagnostics(ws, aUri).filter((d) => /helper2/.test(d.message))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parser recovery: unclosed struct', () => {
  it('does not swallow a following const or uniform', () => {
    const a = parseText('struct S {\n  float a;\nconst float K = 1.0;\nfloat h(){return K;}');
    expect(a.structs[0].fields.map((f) => f.name)).toEqual(['a']);
    expect(a.globals.map((g) => g.name)).toEqual(['K']);
    expect(a.functions.map((f) => f.name)).toEqual(['h']);
    const b = parseText('struct S {\n  float a;\nuniform float uT;\nfloat h(){return uT;}');
    expect(b.structs[0].fields.map((f) => f.name)).toEqual(['a']);
    expect(b.globals.map((g) => g.name)).toEqual(['uT']);
    const c = parseText('uniform B {\n  float a;\nuniform float uT;\nfloat h(){return uT;}');
    expect(c.blocks[0].fields.map((f) => f.name)).toEqual(['a']);
    expect(c.globals.map((g) => g.name)).toEqual(['uT']);
  });

  it('a closed block keeps qualified members', () => {
    const m = parseText('layout(std140) uniform B {\n  layout(offset = 0) highp float a;\n  vec2 b;\n};\n');
    expect(m.blocks[0].fields.map((f) => f.name)).toEqual(['a', 'b']);
  });
});
