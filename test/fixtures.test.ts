// Workspace over the real file system (test/fixtures/project).
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getBuiltins } from '../server/src/builtins';
import { fsPathToUri, NodeFileSystem, Workspace } from '../server/src/core';
import { computeHover } from '../server/src/features/hover';
import { posOf } from './helpers';

const ROOT = resolve(__dirname, 'fixtures', 'project');
const u = (p: string) => fsPathToUri(resolve(ROOT, p));

describe('workspace on disk', () => {
  const ws = new Workspace({ fs: new NodeFileSystem(), builtins: getBuiltins(), roots: [fsPathToUri(ROOT)] });
  const stats = ws.indexWorkspaceSync();

  it('indexes GLSL files and skips excluded folders', () => {
    expect(stats.files).toBe(3);
    expect(ws.findDeclaringFiles('ignored')).toEqual([]);
  });

  it('resolves includes through real paths', () => {
    expect(ws.transitiveIncludes(u('main.glsl'))).toEqual([u('lib/util.glsl'), u('vendor/math/saturate.glsl')]);
    expect(ws.includePathFor(u('lib/util.glsl'), u('vendor/math/saturate.glsl'))).toBe('../vendor/math/saturate.glsl');
  });

  it('hovers a macro from a transitive include with its YAML doc', () => {
    const main = ws.getModel(u('main.glsl'))!;
    const h = computeHover({ workspace: ws }, { textDocument: { uri: u('main.glsl') }, position: posOf(main.text, 'saturate(') });
    const md = (h!.contents as { value: string }).value;
    expect(md).toContain('#define saturate(V) clamp(V, 0.0, 1.0)');
    expect(md).toContain('clamp a value between 0 and 1');
    expect(md).toContain('Defined in [vendor/math/saturate.glsl:9]');
  });

  it('accepts differently spelled URIs for the same file', () => {
    const spelled = 'file:///' + resolve(ROOT, 'main.glsl').replace(/\\/g, '/');
    expect(ws.getModel(spelled)?.uri).toBe(u('main.glsl'));
  });
});
