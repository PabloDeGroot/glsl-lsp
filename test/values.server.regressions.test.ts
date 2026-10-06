// Regressions from the Values panel review: detection, anchoring, labels and
// the color heuristic (server side). Client-side pin logic is in
// values.client.pins.test.ts.
import { describe, expect, it } from 'vitest';
import { anchorAt, at, resolve, textOf } from './valuesServerHelpers';

const res = (text: string, anchor: Parameters<typeof resolve>[1][number]) => resolve(text, [anchor]).anchors![0];

describe('literals inside a locked vector argument', () => {
  const src = (c: string) => `uniform float t;\nvoid f(){ vec2 p = fbm(p * 2.0 + vec2(5.2, ${c}), 4); }`;
  it('the literal under the cursor is its own float target', () => {
    const r = at(src('1.3 - t * 0.|15'));
    expect(r.t).toMatchObject({ kind: 'float' });
    expect(textOf(r.text, r.t)).toBe('0.15');
    expect(r.t!.components[0].editable).toBe(true);
    const r2 = at(src('1.|3 - t * 0.15'));
    expect(textOf(r2.text, r2.t)).toBe('1.3');
  });
  it('the vector keeps its own literal slots and its locked component', () => {
    const r = at(src('1.3 - t * 0.15').replace('5.2', '5.|2'));
    expect(r.t).toMatchObject({ kind: 'vec2' });
    expect(r.t!.components.map((c) => [c.text, c.editable])).toEqual([
      ['5.2', true],
      ['1.3 - t * 0.15', false],
    ]);
  });
  it('more shapes from real shaders', () => {
    expect(textOf(...pair(at('void f(){ vec2 o = vec2(0.0, t * 0.|20); }')))).toBe('0.20');
    expect(textOf(...pair(at('void f(){ vec2 o = vec2(iTime * 0.|03, 0.10); }')))).toBe('0.03');
    expect(textOf(...pair(at('void f(){ vec2 o = vec2(1.|0 / aspect, 1.0); }')))).toBe('1.0');
  });
  it('those literals are children of the statement multi', () => {
    const r = at('uniform float t;\nvoid f(){ vec2 |o = vec2(5.2, 1.3 - t * 0.15); }');
    expect(r.t!.kind).toBe('multi');
    expect(r.t!.children!.map((c) => textOf(r.text, c))).toEqual(['vec2(5.2, 1.3 - t * 0.15)', '1.3', '0.15']);
  });
});

function pair(r: ReturnType<typeof at>): [string, NonNullable<ReturnType<typeof at>['t']>] {
  return [r.text, r.t!];
}

describe('pin anchors: look-alike lines', () => {
  it('a statement pin whose line was deleted goes stale (does not jump to the next `col *= #;`)', () => {
    const src = 'void main(){\n  vec3 col = vec3(0);\n  col *= 0.|8;\n  col += 1.0;\n  col *= 0.5;\n}\n';
    const { anchor } = anchorAt(src);
    expect(anchor.declName).toBeUndefined();
    const deleted = 'void main(){\n  vec3 col = vec3(0);\n  col += 1.0;\n  col *= 0.5;\n}\n';
    expect(res(deleted, anchor).match).toBe('none');
  });
  it('the pinned statement edited in place is still found', () => {
    const src = 'void main(){\n  vec3 col = vec3(0);\n  col *= 0.|8;\n  col += 1.0;\n  col *= 0.5;\n}\n';
    const { anchor } = anchorAt(src);
    const r = res(src.replace('|', '').replace('0.8', '0.75'), anchor);
    expect(r.match).toBe('fingerprint');
    expect(r.target!.components[0].value).toBe(0.75);
  });
  it('strict anchors (the client saw the line removed) need the same text', () => {
    const src = 'void main(){\n  vec3 col = vec3(0);\n  col *= 0.|8;\n  col *= 0.5;\n}\n';
    const { anchor } = anchorAt(src);
    const deleted = 'void main(){\n  vec3 col = vec3(0);\n  col *= 0.5;\n}\n';
    expect(res(deleted, { ...anchor, strict: true }).match).toBe('none');
    // undo restores the same text: found again
    expect(res(src.replace('|', ''), { ...anchor, strict: true }).match).toBe('fingerprint');
  });
  it('LUT entries: an edit above does not move the pin to the neighbouring entry', () => {
    const lut = ['vec3(0.1900, 0.0718, 0.2322)', 'vec3(0.2594, 0.5777, 0.9986)', 'vec3(0.9290, 0.8173, 0.2261)', 'vec3(0.7994, 0.9277, 0.2042)'];
    const body = (extra: string) =>
      `vec3 turbo(float t) {\n${extra}  const vec3 lut[4] = vec3[4](\n${lut.map((l) => `    ${l},`).join('\n').replace(/,$/, '')}\n  );\n  return lut[int(t * 3.0)];\n}\n`;
    const src = body('').replace('vec3(0.9290', 'vec3(0.|9290');
    const { anchor, target } = anchorAt(src);
    expect(target.kind).toBe('vec3');
    const r = res(body('  // a comment\n'), anchor);
    expect(r.target!.components.map((c) => c.text)).toEqual(['0.9290', '0.8173', '0.2261']);
  });
  it('array constructor elements are named `lut[i]` declarations and anchored by name', () => {
    const src = 'vec3 turbo(float t) {\n  const vec3 lut[3] = vec3[3](\n    vec3(0.1, 0.2, 0.3),\n    vec3(0.|4, 0.5, 0.6),\n    vec3(0.7, 0.8, 0.9)\n  );\n  return lut[0];\n}\n';
    const { anchor, target } = anchorAt(src);
    expect(target).toMatchObject({ name: 'lut[1]', declKind: 'const' });
    expect(anchor).toMatchObject({ declName: 'lut[1]', declKind: 'const', functionName: 'turbo' });
    // lines inserted above: found by name
    const moved = src.replace('|', '').replace('vec3 turbo(float t) {\n', 'vec3 turbo(float t) {\n  // x\n  // y\n');
    const r = res(moved, anchor);
    expect(r.match).toBe('declaration');
    // then its value edited in the editor: found on its line
    const r2 = res(moved.replace('0.4, 0.5, 0.6', '0.45, 0.5, 0.6'), r.anchor);
    expect(r2.target!.components[0].value).toBe(0.45);
    // an element inserted before it: the pin follows its entry (now lut[2]), not the index
    const inserted = src.replace('|', '').replace('    vec3(0.1, 0.2, 0.3),\n', '    vec3(0.1, 0.2, 0.3),\n    vec3(0.0, 0.0, 0.0),\n');
    const ri = res(inserted, anchor);
    expect(ri.target!.components.map((c) => c.text)).toEqual(['0.4', '0.5', '0.6']);
    expect(ri.target!.name).toBe('lut[2]');
    // the element deleted (the client marks the anchor strict): stale, not the neighbour
    const gone = src.replace('|', '').replace('    vec3(0.4, 0.5, 0.6),\n', '');
    expect(res(gone, { ...anchor, strict: true }).match).toBe('none');
  });
  it('a multi declaration is anchored by its name and function (fbm variants)', () => {
    const fn = (name: string) => `float ${name}(vec2 p) {\n  float sum = 0.0, amp = 0.5, norm = 0.0;\n  return sum;\n}\n`;
    const src = fn('gfbm') + fn('sfbm').replace('float sum = 0.0,', 'float sum = 0.0,|');
    const { anchor, target } = anchorAt(src);
    expect(target).toMatchObject({ kind: 'multi', name: 'sum', declKind: 'local', functionName: 'sfbm' });
    const helper = 'float helper(float x) {\n' + '  x += 1.0;\n'.repeat(13) + '  return x;\n}\n';
    const edited = fn('gfbm') + helper + fn('sfbm');
    const r = res(edited, anchor);
    expect(r.target!.functionName).toBe('sfbm');
    expect(r.match).toBe('declaration');
  });
});

describe('cosine palettes: common iq forms', () => {
  const pal = (k: string) => `void f(){ vec3 c = vec3(0.5)+vec3(0.|5)*cos(${k}*(vec3(1.0)*t+vec3(0.0,0.33,0.67))); }`;
  it.each(['6.28318', '6.2832', '6.28', 'TAU', '2.0*PI', 'PI*2.0', '2.0*3.14159', '3.1416*2.0'])('K = %s', (k) => {
    expect(at(pal(k)).t!.kind).toBe('palette');
  });
  it('other constants are not palettes', () => {
    expect(at(pal('6.0')).t!.kind).not.toBe('palette');
  });
});

describe('color heuristic on real-world shapes', () => {
  it('color map LUT stops are colors', () => {
    const src = 'vec3 inferno(float t) {\n  const vec3 lut[2] = vec3[2](\n    vec3(0.0015, 0.0005, 0.|0139),\n    vec3(0.9883, 0.9984, 0.6449)\n  );\n  return lut[0];\n}\n';
    expect(at(src).t!.colorish).toBe(true);
  });
  it('a ternary assigned to a variable that reaches fragColor is a color', () => {
    const src = 'void mainImage(out vec4 fragColor, in vec2 p){\n  vec3 c;\n  c = p.x > 0.0 ? vec3(0.|95, 0.35, 0.35) : vec3(0.45, 0.14, 0.14);\n  fragColor = vec4(c, 1.0);\n}\n';
    expect(at(src).t!.colorish).toBe(true);
  });
  it('the argument of hsv2rgb is HSV, not RGB', () => {
    expect(at('vec3 hsv2rgb(vec3 c){ return c; }\nvoid f(){ vec3 col = hsv2rgb(vec3(0.|5, 1.0, 1.0)); }').t!.colorish).toBe(false);
    expect(at('vec3 rgb2hsv(vec3 c){ return c; }\nvoid f(){ vec3 hsv = rgb2hsv(vec3(0.|5, 1.0, 1.0)); }').t!.kind).toBe('vec3');
  });
  it('fragColor of a self-feeding buffer pass holds data, not a color', () => {
    const src = '#iChannel0 "self"\nvoid mainImage(out vec4 fragColor, in vec2 p){\n  fragColor = vec4(0.|0);\n}\n';
    expect(at(src).t!.colorish).toBe(false);
    const image = 'void mainImage(out vec4 fragColor, in vec2 p){\n  fragColor = vec4(0.|2, 0.4, 0.6, 1.0);\n}\n';
    expect(at(image).t!.colorish).toBe(true);
  });
});

describe('labels', () => {
  it('generic builtin parameter names are composed with the callee and the assigned variable', () => {
    expect(at('void f(){ vec3 sun = normalize(vec3(0.|34, 0.27, -0.90)); }').t!.name).toBe('sun · normalize');
    expect(at('void f(){ vec3 col = mix(col, vec3(1.|0), 0.5); }').t!.name).toBe('col · mix(y)');
    expect(at('void f(){ float s = smoothstep(0.1, 0.|25, d); }').t!.name).toBe('edge1');
  });
  it('sibling sub-rows of a multi never share a label', () => {
    const r = at('void f(){ vec3 col = 0.5 + 0.5*sin(t + uv.xyx * vec3(1.0, 1.3, 1.7) + vec3(0.0, 2.0, 4.0))|; }');
    const names = r.t!.children!.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(['col #1', 'col #2', 'col · sin #1', 'col · sin #2']);
  });
});
