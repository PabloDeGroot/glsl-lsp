// Regression tests for completion / include-edit / code action defects found in review.
import { describe, expect, it } from 'vitest';
import { computeIncludeInsertion } from '../server/src/core';
import { IncludeContext } from '../server/src/features/autoInclude';
import { computeCodeActions } from '../server/src/features/codeActions';
import { applyEdits, complete, find, itemsOf, labels, LIB_FILES } from './completionHelpers';
import { cursor, makeWorkspace, parseText, uri } from './helpers';

const insertLine = (text: string) => computeIncludeInsertion(parseText(text), 'lib/a.glsl').position.line;

describe('include insertion placement', () => {
  it('does not treat an option-default #ifndef/#define/#endif as an include guard', () => {
    expect(insertLine('// My shader.\n\n#ifndef OCTAVES\n#define OCTAVES 4\n#endif\n\nvoid mainImage(out vec4 c, in vec2 f){ }')).toBe(5);
    expect(insertLine('#ifndef A\n#define B 2.0\n#endif\nvoid main(){}')).toBe(0);
    // A real guard still gets the include inside.
    expect(insertLine('#ifndef LIB_H\n#define LIB_H\nfloat f() { return 1.0; }\n#endif')).toBe(2);
  });

  it('keeps leading option #defines in front of the include', () => {
    expect(insertLine('// fbm test\n\n#define FBM_OCTAVES 6\n\nvoid mainImage(out vec4 c, in vec2 f){ }')).toBe(3);
    expect(insertLine('#define A 1\nvoid f(){}')).toBe(1);
    expect(insertLine('#define FNC(X) X\n#define B 2\nvoid f(){}')).toBe(2);
  });

  it('ignores includes inside conditionals or below code', () => {
    expect(insertLine('#include "lib/b.glsl"\n#ifdef USE_C\n#include "lib/c.glsl"\n#endif\nvoid main(){}')).toBe(1);
    expect(insertLine('#version 300 es\nvoid f(){ x(); }\n#include "lib/b.glsl"')).toBe(1);
    expect(insertLine('#include "lib/b.glsl"\nvoid f(){\n#include "lib/c.glsl"\n}\nvoid main(){}')).toBe(1);
  });

  it('keeps a doc comment attached to the first declaration', () => {
    const ins = computeIncludeInsertion(parseText('// Returns one.\nfloat one() { return 1.0; }\n'), 'lib/a.glsl');
    expect(ins.position.line).toBe(0);
  });
});

describe('auto-include candidates', () => {
  it('does not prefer another shader multipass common file over the library', () => {
    const files = {
      'lib/common.glsl': 'vec2 uvCentered(vec2 f, vec2 r) { return f / r; }\n',
      'fx/common.glsl': '#include "../lib/common.glsl"\n#define FX_MODE 1\n',
      'fx/image.glsl': '#include "common.glsl"\nvoid mainImage(out vec4 c, in vec2 f) { c = vec4(uvCentered(f, f), 0.0, 1.0); }\n',
      'fx/buffer.glsl': '#include "common.glsl"\nvoid mainImage(out vec4 c, in vec2 f) { c = vec4(0.0); }\n',
      'other/new.glsl': 'void mainImage(out vec4 c, in vec2 f) { vec2 uv = uvCen; }\n',
    };
    const { ws } = makeWorkspace(files);
    const ctx = new IncludeContext(ws, ws.getModel(uri('other/new.glsl'))!);
    expect(ctx.candidatesFor('uvCentered')[0].path).toBe('../lib/common.glsl');
  });
});

describe('completion', () => {
  it('offers swizzles after builtin calls with generic return types', () => {
    const tex = complete('uniform sampler2D t; void main(){ texture(t, vec2(0)).| }', { triggerCharacter: '.' });
    expect(labels(tex.result)).toContain('rgba');
    const norm = complete('void main(){ vec3 a; normalize(a).| }', { triggerCharacter: '.' });
    expect(labels(norm.result)).toContain('xyz');
    expect(labels(norm.result)).not.toContain('xyzw');
    const st = complete('void mainImage(out vec4 c, in vec2 uv){ c = texture(iChannel0, uv).| }', { triggerCharacter: '.' });
    expect(labels(st.result)).toContain('rgb');
    const idx = complete('mat3 m; void main(){ float a = m[0].| }', { triggerCharacter: '.' });
    expect(labels(idx.result)).toContain('xyz');
  });

  it('include path completion in the middle of a path replaces the rest', () => {
    const files = { ...LIB_FILES };
    const r1 = complete('#include "lib/com|mon.glsl"\nvoid main(){}', { files });
    const item = find(r1.result, 'common.glsl')!;
    const edit = item.textEdit as { range: never; newText: string };
    expect(applyEdits(r1.text, [{ range: edit.range, newText: edit.newText }]).split('\n')[0]).toBe('#include "lib/common.glsl"');
    const r2 = complete('#include "lyg|ia/math/const.glsl"\nvoid main(){}', { files });
    const folder = find(r2.result, 'lygia/')!;
    const fe = folder.textEdit as { range: never; newText: string };
    expect(applyEdits(r2.text, [{ range: fe.range, newText: fe.newText }]).split('\n')[0]).toBe('#include "lygia/math/const.glsl"');
  });

  it('offers no auto-include items where a new name is being declared', () => {
    for (const src of ['void main(){ float gno| }', 'float f(vec2 gno|)', 'struct S { float gno|; };', 'void main(){ vec2 rand| = vec2(0); }', 'struct CircleInfo2 { float r; }; void main(){ CircleInfo2 gno| }']) {
      const { result } = complete(src);
      expect(itemsOf(result).filter((i) => i.additionalTextEdits), src).toEqual([]);
    }
    // Still offered in expressions.
    expect(itemsOf(complete('void main(){ float x = gno| }').result).some((i) => i.additionalTextEdits)).toBe(true);
  });
});

describe('remove redundant include', () => {
  it('is not offered when a later include is the only other provider of a name used before it', () => {
    const files = {
      'c.glsl': '#define PI 3.14159\nconst float TAU = 6.28;\n',
      'b.glsl': '#include "c.glsl"\nfloat bb(){return 1.0;}\n',
      'main.glsl': '#include "c.glsl"\nconst float K = PI;\n#include "b.glsl"\nvoid main(){ float x = bb(); }\n',
    };
    const { ws } = makeWorkspace(files);
    const actions = computeCodeActions(
      { workspace: ws },
      { textDocument: { uri: uri('main.glsl') }, range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, context: { diagnostics: [] } },
    );
    expect(actions.map((a) => a.title).filter((t) => /Remove/.test(t))).toEqual([]);
    // Used only after the later include: redundant.
    const { ws: ws2 } = makeWorkspace({ ...files, 'main.glsl': '#include "c.glsl"\n#include "b.glsl"\nconst float K = PI;\nvoid main(){ float x = bb(); }\n' });
    const a2 = computeCodeActions(
      { workspace: ws2 },
      { textDocument: { uri: uri('main.glsl') }, range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, context: { diagnostics: [] } },
    );
    expect(a2.map((a) => a.title).some((t) => /redundant/.test(t))).toBe(true);
    void cursor;
  });
});

describe('remove redundant include (intervening includes)', () => {
  it('is not offered when a file included between it and the later provider uses its names', () => {
    const { ws } = makeWorkspace({
      'const.glsl': '#define PI 3.14159\n',
      'common.glsl': '#include "const.glsl"\nfloat cc(){return 1.0;}\n',
      'b.glsl': 'float usesPi(){ return PI; }\n',
      'main.glsl': '#include "const.glsl"\n#include "b.glsl"\n#include "common.glsl"\nvoid main(){ float x = usesPi(); }\n',
    });
    const actions = computeCodeActions(
      { workspace: ws },
      { textDocument: { uri: uri('main.glsl') }, range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, context: { diagnostics: [] } },
    );
    expect(actions.map((a) => a.title).filter((t) => /Remove/.test(t))).toEqual([]);
  });

  it('also looks through the closure of the intervening include', () => {
    const { ws } = makeWorkspace({
      'const.glsl': '#define PI 3.14159\n',
      'common.glsl': '#include "const.glsl"\nfloat cc(){return 1.0;}\n',
      'b.glsl': 'float usesPi(){ return PI; }\n',
      'wrap.glsl': '#include "b.glsl"\n',
      'main.glsl': '#include "const.glsl"\n#include "wrap.glsl"\n#include "common.glsl"\nvoid main(){ float x = usesPi(); }\n',
    });
    const actions = computeCodeActions(
      { workspace: ws },
      { textDocument: { uri: uri('main.glsl') }, range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, context: { diagnostics: [] } },
    );
    expect(actions.map((a) => a.title).filter((t) => /Remove/.test(t))).toEqual([]);
  });
});

describe('include insertion after precision and option defines', () => {
  it('goes after #version, precision and option #defines, before the first declaration', () => {
    expect(insertLine('#version 300 es\nprecision highp float;\n#define FBM_OCTAVES 6\nvoid main(){}')).toBe(3);
    expect(insertLine('#version 300 es\nprecision highp float;\nvoid main(){}')).toBe(2);
    expect(insertLine('#version 300 es\n#extension GL_OES_standard_derivatives : enable\nprecision mediump float;\nprecision highp int;\n#define A 1\n\nuniform float t;\nvoid main(){}')).toBe(5);
  });
});

describe('no auto-include at declarator names', () => {
  it('second declarator of a comma list and an empty prefix after a type', () => {
    for (const src of ['void main(){ float a, gno| }', 'void main(){ float | }', 'void main(){ vec2 a = vec2(0), rand| }']) {
      const { result } = complete(src);
      expect(itemsOf(result).filter((i) => i.additionalTextEdits), src).toEqual([]);
    }
  });
});

describe('member completion on overloaded builtins', () => {
  it('textureSize picks the overload by sampler type', () => {
    const t = complete('uniform sampler2D t; void main(){ textureSize(t, 0).| }', { triggerCharacter: '.' });
    expect(labels(t.result)).toContain('xy');
    expect(labels(t.result)).not.toContain('xyz');
    const st = complete('void mainImage(out vec4 c, in vec2 uv){ textureSize(iChannel0, 0).| }', { triggerCharacter: '.' });
    expect(labels(st.result)).toContain('xy');
    const t3 = complete('uniform sampler3D t; void main(){ textureSize(t, 0).| }', { triggerCharacter: '.' });
    expect(labels(t3.result)).toContain('xyz');
  });
});
