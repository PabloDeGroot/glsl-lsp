import { describe, expect, it } from 'vitest';
import { computeIncludeInsertion, hasIncludePath, normalizeUri, relativePath } from '../server/src/core';
import { makeWorkspace, parseText, uri } from './helpers';

describe('include resolution', () => {
  const { ws } = makeWorkspace(
    {
      'main.glsl': '#include "lib/common.glsl"\n#include "missing.glsl"\nvoid mainImage(out vec4 c, in vec2 f) {}',
      'lib/common.glsl': '#include "../lygia/math/const.glsl"\n#include "sdf.glsl"\n',
      'lib/sdf.glsl': '#include "common.glsl"\nfloat sd() { return 0.0; }', // cycle back to common
      'lygia/math/const.glsl': '#define PI 3.14159\n',
      'shared/util.glsl': 'float util() { return 1.0; }',
      'deep/a/b/shader.glsl': '#include "util.glsl"\n',
    },
    { includePaths: ['shared'] },
  );

  it('resolves relative to the including file', () => {
    const m = ws.getModel(uri('main.glsl'))!;
    expect(m.includes[0].resolvedUri).toBe(uri('lib/common.glsl'));
    expect(m.includes[1].resolvedUri).toBeUndefined();
    expect(ws.getModel(uri('lib/common.glsl'))!.includes[0].resolvedUri).toBe(uri('lygia/math/const.glsl'));
  });

  it('falls back to configured include paths', () => {
    expect(ws.getModel(uri('deep/a/b/shader.glsl'))!.includes[0].resolvedUri).toBe(uri('shared/util.glsl'));
  });

  it('computes the transitive closure, cycle-safe, in include order', () => {
    expect(ws.transitiveIncludes(uri('main.glsl'))).toEqual([uri('lib/common.glsl'), uri('lygia/math/const.glsl'), uri('lib/sdf.glsl')]);
    expect(ws.transitiveIncludes(uri('lib/sdf.glsl'))).toEqual([uri('lib/common.glsl'), uri('lygia/math/const.glsl')]);
    expect(ws.isReachable(uri('main.glsl'), uri('lygia/math/const.glsl'))).toBe(true);
    expect(ws.isReachable(uri('lygia/math/const.glsl'), uri('main.glsl'))).toBe(false);
  });

  it('tracks includers', () => {
    expect(ws.transitiveIncluders(uri('lygia/math/const.glsl')).sort()).toEqual(
      [uri('lib/common.glsl'), uri('main.glsl'), uri('lib/sdf.glsl')].sort(),
    );
  });

  it('computes include path text relative to the including file', () => {
    expect(ws.includePathFor(uri('lib/common.glsl'), uri('lygia/math/const.glsl'))).toBe('../lygia/math/const.glsl');
    expect(ws.includePathFor(uri('main.glsl'), uri('lib/sdf.glsl'))).toBe('lib/sdf.glsl');
  });

  it('updates the graph when a buffer changes', () => {
    ws.updateDocument(uri('main.glsl'), '#include "shared/util.glsl"\n', 2);
    expect(ws.transitiveIncludes(uri('main.glsl'))).toEqual([uri('shared/util.glsl')]);
    ws.closeDocument(uri('main.glsl'));
    expect(ws.transitiveIncludes(uri('main.glsl'))[0]).toBe(uri('lib/common.glsl'));
  });
});

describe('uri helpers', () => {
  it('normalizes Windows file URIs', () => {
    expect(normalizeUri('file:///C:/Pablo/x.glsl')).toBe(normalizeUri('file:///c%3A/Pablo/x.glsl'));
  });

  it('computes relative paths and refuses across drives', () => {
    expect(relativePath('file:///c%3A/a/lib', 'file:///c%3A/a/lygia/x.glsl')).toBe('../lygia/x.glsl');
    expect(relativePath('file:///c%3A/a', 'file:///d%3A/b.glsl')).toBeUndefined();
  });
});

describe('include insertion', () => {
  it('goes after the last existing include', () => {
    const m = parseText('// header\n#include "a.glsl"\n#include "b.glsl"\n\nvoid main() {}');
    expect(computeIncludeInsertion(m, 'c.glsl')).toEqual({ position: { line: 3, character: 0 }, text: '#include "c.glsl"\n' });
    expect(hasIncludePath(m, './a.glsl')).toBe(true);
  });

  it('goes after #version and shader-toy directives', () => {
    const m = parseText('#version 300 es\n#iChannel0 "self"\n#iKeyboard\nvoid main() {}');
    expect(computeIncludeInsertion(m, 'c.glsl')).toEqual({ position: { line: 3, character: 0 }, text: '#include "c.glsl"\n\n' });
  });

  it('goes after a header comment, separated by a blank line', () => {
    const m = parseText('// my shader\n// does things\n\nvoid main() {}');
    expect(computeIncludeInsertion(m, 'c.glsl')).toEqual({ position: { line: 2, character: 0 }, text: '\n#include "c.glsl"\n' });
  });

  it('goes inside an include guard', () => {
    const m = parseText('#ifndef LIB_H\n#define LIB_H\nfloat f() { return 1.0; }\n#endif');
    expect(computeIncludeInsertion(m, 'c.glsl').position).toEqual({ line: 2, character: 0 });
  });
});
