import { CodeActionKind, type CodeAction, type Diagnostic } from 'vscode-languageserver/node';
import { describe, expect, it } from 'vitest';
import { computeCodeActions, isIncludeUnused, UNDECLARED_IDENTIFIER } from '../server/src/features/codeActions';
import { applyEdits, LIB_FILES } from './completionHelpers';
import { makeWorkspace, posOf, uri } from './helpers';

function actionsAt(text: string, needle: string, options: { delta?: number; diagnostics?: Diagnostic[]; files?: Record<string, string>; path?: string; only?: string[] } = {}) {
  const path = options.path ?? 'main.glsl';
  const { ws } = makeWorkspace({ ...LIB_FILES, ...(options.files ?? {}), [path]: text });
  const pos = posOf(text, needle, options.delta ?? 0);
  const actions = computeCodeActions(
    { workspace: ws },
    { textDocument: { uri: uri(path) }, range: { start: pos, end: pos }, context: { diagnostics: options.diagnostics ?? [], only: options.only } },
  );
  return { actions, ws, text, path };
}

function editedText(text: string, action: CodeAction, path = 'main.glsl'): string {
  return applyEdits(text, action.edit!.changes![uri(path)]);
}

const SHADER = '#include "lib/common.glsl"\n\nvoid mainImage(out vec4 c, in vec2 f) {\n  c = vec4(gnoise(f));\n}\n';

describe('Add #include quick fix', () => {
  it('offers one action per candidate from the cursor, best one preferred', () => {
    const { actions, text } = actionsAt(SHADER, 'gnoise', { delta: 2 });
    expect(actions.map((a) => a.title)).toEqual(['Add #include "lib/procedural.glsl" (provides gnoise)', 'Add #include "lygia/generative/gnoise.glsl"']);
    expect(actions[0].isPreferred).toBe(true);
    expect(actions[1].isPreferred).toBe(false);
    expect(actions[0].kind).toBe(CodeActionKind.QuickFix);
    expect(editedText(text, actions[1])).toBe('#include "lib/common.glsl"\n#include "lygia/generative/gnoise.glsl"\n\nvoid mainImage(out vec4 c, in vec2 f) {\n  c = vec4(gnoise(f));\n}\n');
  });

  it('works from undeclared-identifier diagnostics (anywhere in the requested range) and links them', () => {
    const range = { start: posOf(SHADER, 'gnoise'), end: posOf(SHADER, 'gnoise', 6) };
    const diag: Diagnostic = { range, message: "'gnoise' is not declared", code: UNDECLARED_IDENTIFIER, data: { name: 'gnoise' } };
    const { actions } = actionsAt(SHADER, 'mainImage', { diagnostics: [diag] });
    expect(actions).toHaveLength(2);
    expect(actions[0].diagnostics).toEqual([diag]);
  });

  it('falls back to the diagnostic range text when data is missing', () => {
    const range = { start: posOf(SHADER, 'gnoise'), end: posOf(SHADER, 'gnoise', 6) };
    const { actions } = actionsAt(SHADER, 'mainImage', { diagnostics: [{ range, message: 'x', code: UNDECLARED_IDENTIFIER }] });
    expect(actions.length).toBe(2);
  });

  it('offers nothing for visible symbols, builtins, locals and unknown names', () => {
    expect(actionsAt(SHADER, 'mainImage').actions).toEqual([]);
    const src = '#include "lib/common.glsl"\nvoid f() { float a = uvCentered(vec2(0.0), vec2(1.0)).x + PI + mix(1.0, 2.0, 0.5) + unknownName; }\n';
    expect(actionsAt(src, 'uvCentered', { delta: 1 }).actions).toEqual([]);
    expect(actionsAt(src, 'PI').actions).toEqual([]);
    expect(actionsAt(src, 'mix').actions).toEqual([]);
    expect(actionsAt(src, 'unknownName').actions).toEqual([]);
  });

  it('works in subfolders with ../ paths and macros', () => {
    const src = 'void mainImage(out vec4 c, in vec2 f) { c = vec4(saturate(f.x)); }\n';
    const { actions, text } = actionsAt(src, 'saturate', { path: 'eyes/a/shader.glsl' });
    expect(actions.map((a) => a.title)).toEqual(['Add #include "../../lygia/math/saturate.glsl"']);
    expect(editedText(text, actions[0], 'eyes/a/shader.glsl').startsWith('#include "../../lygia/math/saturate.glsl"\n\nvoid')).toBe(true);
  });

  it('respects context.only', () => {
    expect(actionsAt(SHADER, 'gnoise', { only: [CodeActionKind.Source] }).actions).toEqual([]);
    expect(actionsAt(SHADER, 'gnoise', { only: [CodeActionKind.QuickFix] }).actions).toHaveLength(2);
  });
});

describe('unresolved #include quick fix', () => {
  it('suggests files with the same name', () => {
    const src = '#include "noise/gnoise.glsl"\nvoid f() {}\n';
    const { actions, text } = actionsAt(src, 'gnoise.glsl');
    expect(actions.map((a) => a.title)).toEqual(['Change to "lygia/generative/gnoise.glsl"']);
    expect(editedText(text, actions[0])).toBe('#include "lygia/generative/gnoise.glsl"\nvoid f() {}\n');
  });
});

describe('Remove unused #include', () => {
  it('is offered when nothing from the include is used', () => {
    const src = '#include "lib/common.glsl"\n#include "lib/procedural.glsl"\nvoid f() { float x = gnoise(1.0); }\n';
    const { actions, text } = actionsAt(src, 'common');
    expect(actions.map((a) => a.title)).toEqual(['Remove unused #include "lib/common.glsl"']);
    expect(editedText(text, actions[0])).toBe('#include "lib/procedural.glsl"\nvoid f() { float x = gnoise(1.0); }\n');
  });

  it('is not offered when the file or its transitive provides are used', () => {
    expect(actionsAt('#include "lib/procedural.glsl"\nvoid f() { float x = gnoise(1.0); }\n', 'procedural').actions).toEqual([]);
    // random comes from gnoise.glsl's own include
    expect(actionsAt('#include "lib/procedural.glsl"\nvoid f() { float x = random(1.0); }\n', 'procedural').actions).toEqual([]);
    // PI in a #if counts as a use
    expect(actionsAt('#include "lib/common.glsl"\n#if PI > 3.0\n#endif\n', 'common').actions).toEqual([]);
  });

  it('keeps includes a library re-exports to its includers', () => {
    const files = { 'lib/re.glsl': '#include "../lygia/math/const.glsl"\n', 'shader.glsl': '#include "lib/re.glsl"\nfloat f() { return PI; }\n' };
    const { ws } = makeWorkspace({ ...LIB_FILES, ...files });
    const model = ws.getModel(uri('lib/re.glsl'))!;
    expect(isIncludeUnused(ws, model, model.includes[0])).toBe(false);
  });

  it('treats an include that is also reachable through another one as removable', () => {
    const src = '#include "lygia/generative/random.glsl"\n#include "lygia/generative/gnoise.glsl"\nvoid f() { float x = random(1.0) + gnoise(1.0); }\n';
    const { actions } = actionsAt(src, 'random.glsl');
    expect(actions.map((a) => a.title)).toEqual(['Remove redundant #include "lygia/generative/random.glsl" (included through another #include)']);
  });
});
