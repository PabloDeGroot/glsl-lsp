// Completion on preprocessor lines: directive names after `#`, macro names
// in #ifdef/#ifndef/#undef/#if/#elif, #version profiles and #extension names.

import { CompletionItemKind, InsertTextFormat, MarkupKind, type CompletionItem, type Range } from 'vscode-languageserver/node';
import { type FileModel } from '../../core';
import { TRIGGER_SUGGEST } from './items';
import { Rank, sortText, type CompletionData, type CompletionEnv } from './types';

interface DirectiveSpec {
  name: string;
  snippet?: string;
  doc: string;
  shadertoy?: boolean;
  /** Re-open suggestions after inserting (e.g. #include path completion). */
  retrigger?: boolean;
}

/** Defaults; entries in the builtins registry (`builtins.directives`) override doc/snippet. */
const DIRECTIVES: DirectiveSpec[] = [
  { name: 'include', snippet: 'include "$1"', doc: 'Insert another file. Paths are relative to the including file.', retrigger: true },
  { name: 'define', snippet: 'define ${1:NAME} ${2:value}', doc: 'Define a macro.' },
  { name: 'undef', snippet: 'undef ${1:NAME}', doc: 'Remove a macro definition.' },
  { name: 'ifdef', snippet: 'ifdef ${1:NAME}\n$0\n#endif', doc: 'Compile the following lines if the macro is defined.' },
  { name: 'ifndef', snippet: 'ifndef ${1:NAME}\n$0\n#endif', doc: 'Compile the following lines if the macro is not defined.' },
  { name: 'if', snippet: 'if ${1:condition}\n$0\n#endif', doc: 'Conditional compilation on a constant expression.' },
  { name: 'elif', snippet: 'elif ${1:condition}', doc: 'Else-if branch of a conditional group.' },
  { name: 'else', doc: 'Else branch of a conditional group.' },
  { name: 'endif', doc: 'End of a conditional group.' },
  { name: 'version', snippet: 'version ${1|300 es,330,100,450,460|}', doc: 'GLSL version of the shader, e.g. `#version 300 es`. Must be the first line.' },
  { name: 'extension', snippet: 'extension ${1:GL_OES_standard_derivatives} : ${2|enable,require,warn,disable|}', doc: 'Control a GLSL extension.' },
  { name: 'pragma', snippet: 'pragma ${1}', doc: 'Implementation-defined compiler instruction.' },
  { name: 'line', snippet: 'line ${1:1}', doc: 'Set the line number (and source string) used in diagnostics.' },
  { name: 'error', snippet: 'error ${1:message}', doc: 'Make compilation fail with a message.' },
  ...[0, 1, 2, 3].map(
    (i): DirectiveSpec => ({
      name: `iChannel${i}`,
      snippet: `iChannel${i} "\${1:file://}"`,
      doc: `shader-toy extension: bind a texture, buffer (another .glsl file), \`self\` or keyboard to \`iChannel${i}\`.`,
      shadertoy: true,
    }),
  ),
  {
    name: 'iUniform',
    snippet: 'iUniform ${1|float,int,vec2,vec3,vec4,color3,color4|} ${2:name} = ${3:1.0} in { ${4:0.0}, ${5:1.0} }',
    doc: 'shader-toy extension: a uniform with an editable slider / colour picker, e.g. `#iUniform float u_speed = 1.0 in { 0.0, 4.0 }`.',
    shadertoy: true,
  },
  { name: 'iKeyboard', doc: 'shader-toy extension: keyboard input helpers (`isKeyDown`, `isKeyPressed`, `isKeyToggled`, `Key_A`...).', shadertoy: true },
];

function plainName(snippet: string): string {
  // Strip placeholders for clients without snippet support: `include "$1"` -> `include ""`.
  return snippet.replace(/\$\{\d+\|([^,|]*)[^}]*\}/g, '$1').replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}/g, '').replace(/\$\d+/g, '');
}

export function directiveNameCompletions(env: CompletionEnv, model: FileModel, range: Range): CompletionItem[] {
  const builtins = env.workspace.builtins;
  const shadertoy = env.workspace.builtinFilter(model).shadertoy !== false;
  const specs = new Map<string, DirectiveSpec>(DIRECTIVES.map((d) => [d.name, { ...d }]));
  for (const d of builtins.directives.values()) {
    const base = specs.get(d.name);
    specs.set(d.name, { ...base, name: d.name, doc: d.doc || base?.doc || '', snippet: d.snippet ?? base?.snippet, shadertoy: d.shadertoy ?? base?.shadertoy });
  }
  const items: CompletionItem[] = [];
  let i = 0;
  for (const d of specs.values()) {
    i++;
    if (d.shadertoy && !shadertoy) continue;
    const snippet = d.snippet;
    const useSnippet = !!snippet && env.snippetSupport;
    const newText = useSnippet ? snippet! : snippet ? plainName(snippet) : d.name;
    const item: CompletionItem = {
      label: '#' + d.name,
      filterText: d.name,
      kind: CompletionItemKind.Keyword,
      detail: d.shadertoy ? 'shader-toy directive' : 'preprocessor directive',
      documentation: { kind: MarkupKind.Markdown, value: d.doc },
      sortText: sortText(d.shadertoy ? '1' : '0', String(i).padStart(2, '0')),
      textEdit: { range, newText },
      insertTextFormat: useSnippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
    };
    if (d.retrigger && useSnippet) item.command = TRIGGER_SUGGEST;
    items.push(item);
  }
  return items;
}

/** Macro names visible from the file (+ builtin macros), for #ifdef & co. */
export function macroNameCompletions(env: CompletionEnv, model: FileModel, offset: number, allowDefined: boolean): CompletionItem[] {
  const ws = env.workspace;
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const visible = ws.visibleSymbols(model.uri, model.lines.positionAt(offset));
  for (const s of visible.globals) {
    if (s.kind !== 'macro' || seen.has(s.name)) continue;
    seen.add(s.name);
    items.push({
      label: s.name,
      kind: CompletionItemKind.Constant,
      detail: s.isIncludeGuard ? 'include guard' : `#define ${s.name}${s.params ? `(${s.params.join(', ')})` : ''}`,
      sortText: sortText(s.uri === model.uri ? Rank.file : Rank.included, s.name),
      data: { k: 'g', u: model.uri, n: s.name, f: s.uri } satisfies CompletionData,
    });
  }
  for (const m of ws.builtins.macros.values()) {
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    items.push({ label: m.name, kind: CompletionItemKind.Constant, detail: 'builtin macro', sortText: sortText(Rank.builtin, m.name), data: { k: 'b', u: model.uri, n: m.name } satisfies CompletionData });
  }
  if (allowDefined) {
    items.push({ label: 'defined', kind: CompletionItemKind.Keyword, detail: 'defined(NAME)', sortText: sortText(Rank.keyword, 'defined') });
  }
  return items;
}

const VERSIONS: [string, string][] = [
  ['300 es', 'GLSL ES 3.00 (WebGL 2, Shadertoy)'],
  ['100', 'GLSL ES 1.00 (WebGL 1)'],
  ['330', 'GLSL 3.30 core'],
  ['450', 'GLSL 4.50'],
  ['460', 'GLSL 4.60'],
  ['310 es', 'GLSL ES 3.10'],
  ['320 es', 'GLSL ES 3.20'],
  ['150', 'GLSL 1.50'],
  ['120', 'GLSL 1.20'],
];

export function versionCompletions(range: Range): CompletionItem[] {
  return VERSIONS.map(([v, doc], i) => ({
    label: v,
    kind: CompletionItemKind.EnumMember,
    detail: doc,
    sortText: String(i).padStart(2, '0'),
    textEdit: { range, newText: v },
  }));
}

const EXTENSIONS = [
  'GL_OES_standard_derivatives',
  'GL_EXT_shader_texture_lod',
  'GL_EXT_frag_depth',
  'GL_EXT_draw_buffers',
  'GL_ARB_separate_shader_objects',
  'GL_ARB_shading_language_420pack',
  'GL_GOOGLE_include_directive',
  'GL_EXT_shader_explicit_arithmetic_types',
];

export function extensionCompletions(env: CompletionEnv, range: Range): CompletionItem[] {
  return EXTENSIONS.map((name) => ({
    label: name,
    kind: CompletionItemKind.Module,
    textEdit: { range, newText: env.snippetSupport ? `${name} : \${1|enable,require,warn,disable|}` : name },
    insertTextFormat: env.snippetSupport ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
  }));
}
