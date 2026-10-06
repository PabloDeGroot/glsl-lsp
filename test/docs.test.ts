import { describe, expect, it } from 'vitest';
import { docSummary, formatDocMarkdown, paramDoc, parseYamlDoc, plainTextToMarkdown } from '../server/src/core';
import { parseText } from './helpers';

const LYGIA_FILE = `#include "random.glsl"

/*
contributors: Patricio Gonzalez Vivo
description: Gradient Noise
use: gnoise(<float> x)
options:
    - GNOISE_NOISE_FNC: noise function used for the lattice
license:
    - Copyright (c) 2021 Patricio Gonzalez Vivo under Prosperity License
*/

#ifndef GNOISE_NOISE_FNC
#define GNOISE_NOISE_FNC(UV) random(UV)
#endif

#ifndef FNC_GNOISE
#define FNC_GNOISE
float gnoise(float x) { return x; }

// Own doc wins over the file block.
float gnoise(vec2 st) { return st.x; }
#endif
`;

describe('doc extraction: plain comments', () => {
  it('attaches contiguous // lines directly above a function', () => {
    const m = parseText('// ---- section\n\n// Centered coords.\n// Second line.\nvec2 uvc(vec2 f) { return f; }');
    expect(m.functions[0].doc).toMatchObject({ style: 'line', text: 'Centered coords.\nSecond line.' });
  });

  it('a blank line breaks association', () => {
    const m = parseText('// Not a doc.\n\nfloat f() { return 1.0; }');
    expect(m.functions[0].doc).toBeUndefined();
  });

  it('a trailing comment of earlier code is not a doc of the next line', () => {
    const m = parseText('float a = 1.0; // about a\nfloat b = 2.0;');
    const [a, b] = m.globals;
    expect(a.doc?.text).toBe('about a');
    expect(b.doc).toBeUndefined();
  });

  it('supports /** */ javadoc blocks', () => {
    const m = parseText('/**\n * Signed distance.\n * @param p point\n */\nfloat sd(vec3 p) { return 0.0; }');
    const doc = m.functions[0].doc!;
    expect(doc.style).toBe('block');
    expect(doc.text).toBe('Signed distance.\n@param p point');
    expect(paramDoc(doc, 'p')).toBe('point');
  });

  it('reads trailing docs for parameters, fields and locals', () => {
    const m = parseText(
      'struct S {\n  float a; // the a\n};\nfloat f(float x,  // the x\n        float y)  // the y\n{\n  float i = floor(x);  // integer\n  return i;\n}',
    );
    expect(m.structs[0].fields[0].doc?.text).toBe('the a');
    expect(m.functions[0].params.map((p) => p.doc?.text)).toEqual(['the x', 'the y']);
    expect(m.functions[0].scope!.symbols.find((s) => s.name === 'i')!.doc?.text).toBe('integer');
  });
});

describe('doc extraction: LYGIA YAML blocks', () => {
  const m = parseText(LYGIA_FILE);

  it('applies the file block to functions without their own doc', () => {
    const [g1, g2] = m.functions;
    expect(g1.doc).toMatchObject({ style: 'yaml', inherited: true });
    expect(g1.doc!.yaml!.values['description']).toBe('Gradient Noise');
    expect(g2.doc).toMatchObject({ style: 'line', text: 'Own doc wins over the file block.' });
    expect(m.fileDoc?.style).toBe('yaml');
  });

  it('documents option macros from the options list', () => {
    const opt = m.macros.find((x) => x.name === 'GNOISE_NOISE_FNC')!;
    expect(opt.doc?.text).toContain('noise function used for the lattice');
    expect(m.macros.find((x) => x.name === 'FNC_GNOISE')!.isIncludeGuard).toBe(true);
  });

  it('parses YAML lists, inline lists and block scalars', () => {
    const y = parseYamlDoc(
      'contributors: ["A", "B"]\ndescription: |\n    Line one.\n    Line two.\nuse:\n    - <float> f(<vec2> st)\n    - <float> f(<vec3> p)\noptions:\n    - X: about x\n      continued',
    );
    expect(y.lists['contributors']).toEqual(['A', 'B']);
    expect(y.values['description']).toBe('Line one.\nLine two.');
    expect(y.lists['use']).toEqual(['<float> f(<vec2> st)', '<float> f(<vec3> p)']);
    expect(y.lists['options']).toEqual(['X: about x continued']);
  });
});

describe('doc markdown', () => {
  it('renders LYGIA docs: description, usage block, options, contributors; no license', () => {
    const md = formatDocMarkdown(parseText(LYGIA_FILE).functions[0].doc);
    expect(md).toContain('Gradient Noise');
    expect(md).toContain('**Usage**\n```glsl\ngnoise(<float> x)\n```');
    expect(md).toContain('- `GNOISE_NOISE_FNC`: noise function used for the lattice');
    expect(md).toContain('*Contributors: Patricio Gonzalez Vivo*');
    expect(md).not.toContain('Prosperity');
  });

  it('renders plain comments as paragraphs, lists and indented code', () => {
    const md = plainTextToMarkdown('Joins these\nlines.\n\n- item one\n- item two\nInclude it with:\n    #include "lib/common.glsl"');
    expect(md).toBe('Joins these lines.\n\n- item one\n- item two\n\nInclude it with:\n\n```glsl\n#include "lib/common.glsl"\n```');
  });

  it('escapes markdown-significant characters in prose', () => {
    expect(plainTextToMarkdown('a*b*c uses <float> and u_tint')).toBe('a\\*b\\*c uses \\<float> and u\\_tint');
  });

  it('summarizes the first sentence', () => {
    expect(docSummary(parseText('// Darken towards the edges. uv should come from x.\nfloat v() { return 1.0; }').functions[0].doc)).toBe(
      'Darken towards the edges.',
    );
  });
});
