import { describe, expect, it } from 'vitest';
import { at, textOf } from './valuesServerHelpers';

describe('values: float literals', () => {
  it('literal under cursor, declaration metadata', () => {
    const { t, text } = at('void f(){ float r = 0.2|5; }');
    expect(t).toMatchObject({ kind: 'float', name: 'r', declKind: 'local', functionName: 'f', colorish: false });
    expect(textOf(text, t)).toBe('0.25');
    expect(t!.components).toHaveLength(1);
    expect(t!.components[0]).toMatchObject({ value: 0.25, text: '0.25', editable: true });
    expect(t!.id).toBe('float:0:20');
    expect(t!.anchor).toMatchObject({ kind: 'float', declName: 'r', declKind: 'local', functionName: 'f', line: 0, ordinal: 0 });
  });

  it('cursor may touch either end of the literal', () => {
    expect(textOf(at('float r = |0.25;').text, at('float r = |0.25;').t)).toBe('0.25');
    expect(textOf('float r = 0.25;', at('float r = 0.25|;').t)).toBe('0.25');
  });

  it('const / global / define declaration kinds', () => {
    expect(at('const float K = 2|.0;').t).toMatchObject({ name: 'K', declKind: 'const' });
    expect(at('float g = 2|.0;').t).toMatchObject({ name: 'g', declKind: 'global' });
    expect(at('void f(){ const float K = 2|.0; }').t).toMatchObject({ name: 'K', declKind: 'const', functionName: 'f' });
    expect(at('#define SPEED 1.|5\n').t).toMatchObject({ kind: 'float', name: 'SPEED', declKind: 'define' });
  });

  it('unary minus belongs to the literal', () => {
    const { t, text } = at('void f(){ float a = -0.|5; }');
    expect(textOf(text, t)).toBe('-0.5');
    expect(t!.components[0]).toMatchObject({ value: -0.5, text: '-0.5' });
  });

  it('binary minus does not', () => {
    const { t, text } = at('void f(){ float a = x - 0.|5; }');
    expect(textOf(text, t)).toBe('0.5');
    const r2 = at('void f(){ float a = x -0.|5; }');
    expect(textOf(r2.text, r2.t)).toBe('0.5');
    const r3 = at('void f(){ float a = x - -0.|5; }');
    expect(textOf(r3.text, r3.t)).toBe('-0.5');
    const r4 = at('void f(){ float a = (x) -0.|5; }');
    expect(textOf(r4.text, r4.t)).toBe('0.5');
  });

  it('minus after return / comma / operator is unary', () => {
    const r = at('float f(){ return -1|.0; }');
    expect(textOf(r.text, r.t)).toBe('-1.0');
    const r2 = at('float f(){ return mix(a, -2.|0, 0.5); }');
    expect(textOf(r2.text, r2.t)).toBe('-2.0');
    const r3 = at('float f(){ return a * -2.|0; }');
    expect(textOf(r3.text, r3.t)).toBe('-2.0');
  });

  it('exponent and f suffix literals', () => {
    const { t } = at('float k = 1.5e|-3;');
    expect(t!.components[0].value).toBeCloseTo(0.0015);
    expect(at('float k = 2.|0f;').t!.components[0]).toMatchObject({ value: 2, text: '2.0f' });
  });

  it('integer literals are targets only under the cursor', () => {
    const r = at('void f(){ int n = |3; }');
    expect(r.t).toMatchObject({ kind: 'float', name: 'n' });
    expect(r.t!.components[0]).toMatchObject({ value: 3, integer: true });
    // statement-level resolution never picks an integer
    expect(at('void f(){ int n = 3; |}').t).toBeNull();
  });

  it('excluded contexts: version, layout, array sizes, for ints, includes', () => {
    expect(at('#version 3|30 core\n').t).toBeNull();
    expect(at('layout(location = |0) out vec4 o;').t).toBeNull();
    expect(at('float a[|4];').t).toBeNull();
    expect(at('void f(){ float a[4]; float b = a[|2]; }').t).toBeNull();
    expect(at('void f(){ for (int i = |0; i < 8; i++) {} }').t).toBeNull();
    expect(at('#if def|ined(X) && Y > 3\n#endif\n').t).toBeNull();
    expect(at('#iChannel0 "file://tex|.png"\n').t).toBeNull();
    // floats in for headers are fine
    expect(at('void f(){ for (float i = 0.|0; i < 8.0; i++) {} }').t).toMatchObject({ kind: 'float' });
  });

  it('hex and unsigned literals are ignored', () => {
    expect(at('uint h = 0xFF|u;').t).toBeNull();
  });

  it('nothing in comments, whitespace-only lines or strings of code', () => {
    expect(at('float r = 0.25; // value 0.|5\n').t).toBeNull();
    expect(at('/* 0.|5 */ float r;').t).toBeNull();
    expect(at('float r = 0.25;\n|\nfloat s = 1.0;').t).toBeNull();
    expect(at('void f(){|}\n').t).toBeNull();
  });

  it('no throw on garbage', () => {
    expect(() => at('vec3 c = vec3(((( ;;; } { |vec4(0.5')).not.toThrow();
  });
});

describe('values: vectors', () => {
  it('vec3 with name, color heuristic and splat', () => {
    const { t, text } = at('void f(){ vec3 col = vec3(1.0, |0.5, 0.2); }');
    expect(t).toMatchObject({ kind: 'vec3', name: 'col', declKind: 'local', ctor: 'vec3', colorish: true });
    expect(t!.splat).toBeUndefined();
    expect(textOf(text, t)).toBe('vec3(1.0, 0.5, 0.2)');
    expect(t!.components.map((c) => c.value)).toEqual([1, 0.5, 0.2]);
    const s = at('void f(){ vec3 col = vec3(0.|5); }').t!;
    expect(s.splat).toBe(true);
    expect(s.components).toHaveLength(1);
  });

  it('vec3 that is not a color', () => {
    const { t } = at('void f(){ vec3 lightDir = vec3(0.3, 0.|8, 0.52); }');
    expect(t).toMatchObject({ kind: 'vec3', name: 'lightDir', colorish: false });
    expect(at('void f(){ vec3 pos = vec3(0.3, 0.|8, 0.52); }').t!.colorish).toBe(false);
  });

  it('HDR colors are still colorish by name', () => {
    expect(at('void f(){ vec3 col = vec3(4.0, 2.|0, 1.0); }').t!.colorish).toBe(true);
  });

  it('colors mode', () => {
    expect(at('void f(){ vec3 pos = vec3(0.1, 0.|2, 0.3); }', {}, 'all').t!.colorish).toBe(true);
    expect(at('void f(){ vec3 pos = vec3(1.1, 0.|2, 0.3); }', {}, 'all').t!.colorish).toBe(false);
    expect(at('void f(){ vec3 col = vec3(0.1, 0.|2, 0.3); }', {}, 'off').t!.colorish).toBe(true);
  });

  it('vec2 / vec4', () => {
    expect(at('vec2 uv = vec2(0.5, 0.|5);').t).toMatchObject({ kind: 'vec2', colorish: false });
    const v4 = at('vec4 tint = vec4(0.1, 0.2, 0.|3, 1.0);').t!;
    expect(v4).toMatchObject({ kind: 'vec4', colorish: true });
    expect(v4.components).toHaveLength(4);
  });

  it('negative components and spacing', () => {
    const { t } = at('vec2 p = vec2( -0.5 ,|  1.0 );');
    expect(t!.components.map((c) => c.text)).toEqual(['-0.5', '1.0']);
    expect(t!.components[0].range.start.character).toBe('vec2 p = vec2( '.length);
  });

  it('constructors with expressions have locked components', () => {
    const { t } = at('void f(){ vec3 c = vec3(t, 0.|5, 1.0); }');
    expect(t).toMatchObject({ kind: 'vec3' });
    expect(t!.components.map((c) => c.editable)).toEqual([false, true, true]);
    expect(t!.components[0].text).toBe('t');
    expect(Number.isNaN(t!.components[0].value)).toBe(true);
  });

  it('constructors mixing vectors are not vec targets', () => {
    const r = at('void f(){ vec4 c = vec4(col, 1.|0); }');
    expect(r.t).toMatchObject({ kind: 'float' });
    expect(at('void f(){ vec3 c = vec3(uv, 0.|5); }').t).toMatchObject({ kind: 'float' });
    expect(at('void f(){ vec3 c = vec3(|x); }').t).toBeNull();
  });

  it('nested vec inside vec4(vec3(..), 1.0): cursor on inner vec', () => {
    const r = at('void f(){ vec4 c = vec4(vec3(0.1, |0.2, 0.3), 1.0); }');
    expect(r.t).toMatchObject({ kind: 'vec3' });
    expect(textOf(r.text, r.t)).toBe('vec3(0.1, 0.2, 0.3)');
  });

  it('color3 constructor is colorish', () => {
    const r = at('#iUniform color3 u_tint = color3(1.0, 0.|78, 0.55)\n');
    expect(r.t).toMatchObject({ kind: 'vec3', ctor: 'color3', name: 'u_tint', declKind: 'iUniform', colorish: true });
    expect(r.t!.uniform).toMatchObject({ declaredType: 'color3' });
  });

  it('vec constructors inside #define', () => {
    const r = at('#define SKY vec3(0.3, 0.|5, 0.9)\n');
    expect(r.t).toMatchObject({ kind: 'vec3', name: 'SKY', declKind: 'define', colorish: true });
  });

  it('member access ctor and arrays are not targets', () => {
    // `x.vec2(...)` is not a constructor: only the plain float inside is a target
    expect(at('float a = x.vec2(0.|5);').t).toMatchObject({ kind: 'float' });
  });

  it('cursor on a ctor keyword or paren hits the vec', () => {
    expect(at('vec3 c = |vec3(1.0, 2.0, 3.0);').t).toMatchObject({ kind: 'vec3' });
    expect(at('vec3 c = vec3(1.0, 2.0, 3.0|);').t).toMatchObject({ kind: 'vec3' });
    expect(at('vec3 c = vec3(1.0, 2.0, 3.0)|;').t).toMatchObject({ kind: 'vec3' });
  });
});

describe('values: #iUniform', () => {
  const src = `#iUniform float u_speed = 1.0 in { 0.0, 4.0 } step 0.1
#iUniform vec2 u_pos = vec2(0.5, 0.5) in { -1.0, 1.0 }
#iUniform float u_plain = 2.0
void f(){ float x = u_speed; }
`;
  it('default value with range, step', () => {
    const r = at(src.replace('1.0 in', '1.|0 in'));
    expect(r.t).toMatchObject({ kind: 'float', name: 'u_speed', declKind: 'iUniform' });
    expect(r.t!.uniform).toEqual({ declaredType: 'float', min: 0, max: 4, step: 0.1 });
    expect(r.t!.anchor).toMatchObject({ declName: 'u_speed', declKind: 'iUniform' });
  });
  it('bounds are not targets', () => {
    const r = at(src.replace('4.0 }', '4.|0 }'));
    // cursor on the bound: the directive's only target is the default
    expect(r.t).toMatchObject({ name: 'u_speed', kind: 'float' });
    expect(r.t!.components[0].text).toBe('1.0');
  });
  it('vec2 uniform and no-range uniform', () => {
    const v = at(src.replace('0.5, 0.5', '0.5, 0.|5'));
    expect(v.t).toMatchObject({ kind: 'vec2', name: 'u_pos' });
    expect(v.t!.uniform).toMatchObject({ min: -1, max: 1 });
    const p = at(src.replace('2.0\nvoid', '2.|0\nvoid'));
    expect(p.t!.uniform).toEqual({ declaredType: 'float' });
  });
  it('identifier use resolves to the uniform default', () => {
    const r = at(src.replace('= u_speed;', '= u_sp|eed;'));
    expect(r.t).toMatchObject({ kind: 'float', name: 'u_speed', declKind: 'iUniform' });
    expect(r.t!.components[0].range.start.line).toBe(0);
  });
  it('uniform declared in an included file', () => {
    const r = at('#include "u.glsl"\nvoid f(){ float x = u_sp|eed * 2.0; }', {
      'u.glsl': '#iUniform float u_speed = 1.5 in { 0.0, 4.0 }\n',
    });
    expect(r.t).toMatchObject({ name: 'u_speed', declKind: 'iUniform', uri: 'file:///ws/u.glsl' });
    expect(r.t!.components[0].value).toBe(1.5);
  });
});

describe('values: identifier resolution', () => {
  it('const / global / local / define references', () => {
    expect(at('const float K = 2.0;\nvoid f(){ float x = K| + 3.0; }').t).toMatchObject({ name: 'K', declKind: 'const' });
    expect(at('#define SPEED 1.5\nvoid f(){ float x = SPE|ED + 3.0; }').t).toMatchObject({ name: 'SPEED', declKind: 'define' });
    expect(at('void f(){ float r = 0.3; float x = r| + 3.0; }').t).toMatchObject({ name: 'r', declKind: 'local', kind: 'float' });
  });
  it('identifier with a non-literal initializer falls back to the statement', () => {
    const r = at('void f(){ float r = a * 2.0; float x = r| + 3.0; }');
    expect(r.t).toMatchObject({ kind: 'float', name: 'x' });
    expect(r.t!.components[0].value).toBe(3);
  });
  it('assignment target stays on its own statement', () => {
    const r = at('void f(){ vec3 col = vec3(0.1); col| = vec3(0.7, 0.8, 0.9); }');
    expect(r.t!.components.map((c) => c.value)).toEqual([0.7, 0.8, 0.9]);
  });
  it('function-like macros do not resolve', () => {
    expect(at('#define F(x) 2.0\nvoid f(){ float y = F|(1.0); }').t).toMatchObject({ kind: 'float' });
  });
});

describe('values: names and context', () => {
  it('assignment targets', () => {
    expect(at('void f(){ vec4 fragColor; fragColor = vec4(0.1, 0.|2, 0.3, 1.0); }').t).toMatchObject({ name: 'fragColor', declKind: 'assignment', colorish: true });
    expect(at('void f(){ vec3 col; col.rgb = vec3(0.|1); }').t).toMatchObject({ name: 'col', declKind: 'assignment' });
    expect(at('void f(){ float x; x *= 0.|5; }').t).toMatchObject({ name: 'x', declKind: 'assignment' });
  });
  it('call arguments get the parameter name', () => {
    expect(at('void f(){ float s = smoothstep(0.1, 0.|25, d); }', {}, 'heuristic').t).toMatchObject({ name: 'edge1', declKind: 'argument' });
    expect(at('float g(float amount, float t){ return t; }\nvoid f(){ float s = g(0.|5, 1.0); }').t).toMatchObject({
      name: 'amount',
      declKind: 'argument',
    });
    // generic builtin parameter names (`a`, `x`, `y`) are composed with the callee and the assigned variable
    expect(at('void f(){ float s = mix(a, b, 0.|5); }').t).toMatchObject({ name: 's · mix(a)', declKind: 'argument' });
  });
  it('unnamed targets get a windowed snippet of the line', () => {
    const t = at('void f(){ return_value = (a + 0.|5) / b; }').t!;
    expect(t.snippet.length).toBeLessThanOrEqual(48);
    expect(t.snippet).toContain('0.5');
  });
  it('non-exact initializers are assignments, not declarations', () => {
    const t = at('void f(){ float r = 0.|25 * k; }').t!;
    expect(t).toMatchObject({ name: 'r', declKind: 'assignment' });
    expect(t.anchor.declName).toBeUndefined();
  });
  it('multiple declarators', () => {
    const r = at('void f(){ float a = 1.0, b = 0.|5; }');
    expect(r.t).toMatchObject({ name: 'b', declKind: 'local' });
  });
  it('else / if statements are assignments', () => {
    expect(at('void f(){ if (x) col = vec3(0.|5); }').t).toMatchObject({ name: 'col', declKind: 'assignment' });
    expect(at('void f(){ if (x) {} else col = vec3(0.|5); }').t).toMatchObject({ name: 'col', declKind: 'assignment' });
  });
});

describe('values: statements and multi', () => {
  it('statement with several literals -> multi', () => {
    const r = at('void f(){ float s = smoothstep(0.1, 0.25, d); } // |');
    expect(r.t).toBeNull();
    const m = at('void f(){ float s = smoothstep(0.1, 0.25, d)|; }');
    expect(m.t).toMatchObject({ kind: 'multi', name: 's', declKind: 'local', functionName: 'f' });
    expect(m.t!.children!.map((c) => [c.name, c.components[0].value])).toEqual([
      ['edge0', 0.1],
      ['edge1', 0.25],
    ]);
    expect(m.t!.activeChild).toBeDefined();
    expect(m.t!.components).toEqual([]);
    expect(m.t!.colorish).toBe(false);
  });
  it('cursor on a literal inside a multi statement gives the float', () => {
    expect(at('void f(){ float s = smoothstep(0.1, 0.2|5, d); }').t).toMatchObject({ kind: 'float', name: 'edge1' });
  });
  it('activeChild is the child nearest the cursor', () => {
    const m = at('void f(){ float s = smoothstep(0.1, 0.25, d|) + 1.0 * 3.0; }').t!;
    expect(m.kind).toBe('multi');
    expect(m.children).toHaveLength(4);
    expect(m.activeChild).toBe(1);
    const m2 = at('void f(){ float s = 4.0 * a + b |* 0.5; }').t!;
    expect(m2.children).toHaveLength(2);
  });
  it('vec constructors are one child', () => {
    const m = at('void f(){ vec3 c = mix(vec3(0.1, 0.2, 0.3), vec3(1.0), 0.5)| ; }').t!;
    expect(m.kind).toBe('multi');
    expect(m.children!.map((c) => c.kind)).toEqual(['vec3', 'vec3', 'float']);
  });
  it('integers are never multi children', () => {
    const t = at('void f(){ float x = pow(a, 2) * 0.5 + b|; }').t!;
    expect(t).toMatchObject({ kind: 'float' });
    expect(t.components[0].value).toBe(0.5);
  });
  it('single target on the line is picked from the whitespace/identifier', () => {
    const r = at('void f(){ float x = a + |b * 0.5; }');
    expect(r.t).toMatchObject({ kind: 'float' });
  });
  it('multi-line statements', () => {
    const src = 'void f(){\n  float x = a * 0.5 +\n    |b * 0.25;\n}';
    const m = at(src).t!;
    expect(m.kind).toBe('multi');
    expect(m.range.start.line).toBe(1);
    expect(m.range.end.line).toBe(2);
  });
  it('multi in a #define body', () => {
    const m = at('#define MIX(a) mix(a, 0.5, 0.|25)\n');
    expect(m.t).toMatchObject({ kind: 'float' });
    const m2 = at('#define OFFSET| vec2(1.0, 2.0) * 0.5 + 0.1\n').t!;
    expect(m2.kind).toBe('multi');
    expect(m2.declKind).toBe('define');
    expect(m2.name).toBe('OFFSET');
  });
  it('empty line between statements gives nothing', () => {
    expect(at('float a = 0.5;\n|\nfloat b = 0.25;').t).toBeNull();
    expect(at('void f(){\n  |\n}').t).toBeNull();
  });
  it('falls back to the nearest target on the line', () => {
    // cursor in the `for` header: not part of a statement with targets, but the line has one
    const r = at('void f(){ for (float i = 0.0; i < 8.0|; i++) {} }');
    expect(r.t).toMatchObject({ kind: 'float' });
  });
});

describe('values: palettes', () => {
  const call = 'vec3 c = palette(t, vec3(0.5), vec3(0.5, 0.5, 0.5), vec3(1.0, 1.0, 1.0), vec3(0.0, 0.33, 0.67));';
  it('palette(t, a, b, c, d)', () => {
    const variants = [call.replace('palette(', 'pal|ette('), call.replace('vec3(0.5)', 'vec3(0.|5)'), call.replace('0.33', '0.3|3'), call.replace('palette(t', 'palette(t|')];
    for (const src of variants) {
      const r = at(src);
      expect(r.t).toMatchObject({ kind: 'palette', name: 'c', paletteShape: 'call', colorish: true });
      expect(r.t!.children!.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd']);
      expect(r.t!.children![0].splat).toBe(true);
      expect(r.t!.children![3].components.map((c) => c.value)).toEqual([0, 0.33, 0.67]);
      expect(r.t!.components).toEqual([]);
    }
  });
  it('requires literal vec3 args', () => {
    const r = at('vec3 c = palette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, p|, 0.67));');
    expect(r.t?.kind).not.toBe('palette');
    expect(at('vec3 c = palette(t, a, b, c, d|);').t).toBeNull();
  });
  it('non-palette-named call needs exactly five args', () => {
    const five = at('vec3 c = ramp(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, |0.33, 0.67));').t;
    expect(five?.kind).toBe('palette');
    const six = at('vec3 c = ramp(t, k, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, |0.33, 0.67));').t;
    expect(six?.kind).not.toBe('palette');
    const named = at('vec3 c = myPalette(t, k, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, |0.33, 0.67));').t;
    expect(named?.kind).toBe('palette');
  });
  it('expression shape, whitespace tolerant and TAU', () => {
    const e1 = at('vec3 c = vec3(0.5)+vec3(0.5)*cos(6.28318*(vec3(1.0)*t+vec3(0.0,0.33,0.67)))|;').t!;
    expect(e1).toMatchObject({ kind: 'palette', paletteShape: 'expression', name: 'c' });
    expect(e1.children!.map((c) => c.kind)).toEqual(['vec3', 'vec3', 'vec3', 'vec3']);
    const e2 = at('vec3 c = vec3(0.5, 0.5, 0.5) + vec3(0.5, 0.5, 0.5) * cos( TAU * ( t * vec3(1.0, 1.0, 1.0) + vec3(0.0, 0.1, 0.2) ) |);').t!;
    expect(e2.paletteShape).toBe('expression');
    const e3 = at('vec3 c = vec3(0.5) + vec3(0.5) * cos(2.0 * PI * (vec3(1.0) * (t * 2.0 + 1.0) + vec3(0.|3)));').t!;
    expect(e3.paletteShape).toBe('expression');
    const e4 = at('vec3 c = vec3(0.5) + vec3(0.5) * cos(3.0 * (vec3(1.0) * t + vec3(0.|3)));').t!;
    expect(e4.kind).not.toBe('palette');
  });
  it('palette inside a bigger expression keeps the range of the palette', () => {
    const r = at('void f(){ vec3 col = 0.5 * palette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.|0, 0.33, 0.67)); }');
    expect(r.t!.kind).toBe('palette');
    expect(textOf(r.text, r.t)!.startsWith('palette(')).toBe(true);
  });
  it('statement containing a palette and other numbers is a multi with the palette as one child', () => {
    const r = at('void f(){ vec3 col = 0.5 * palette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67)) + |x; }').t!;
    expect(r.kind).toBe('multi');
    expect(r.children!.map((c) => c.kind)).toEqual(['float', 'palette']);
  });
});

describe('values: version and uri', () => {
  it('reports the document version and uri', () => {
    const r = at('float a = 0.|5;');
    expect(r.t!.uri).toBe('file:///ws/main.glsl');
    expect(r.t!.version).toBe(1);
  });
  it('unknown document -> null', async () => {
    const { makeEnv } = await import('./valuesServerHelpers');
    const { computeValueTargets } = await import('../server/src/features/values/targets');
    const { env } = makeEnv({ 'main.glsl': 'float a = 0.5;' });
    const res = computeValueTargets(env, { uri: 'file:///ws/none.glsl', position: { line: 0, character: 0 }, anchors: [] });
    expect(res.cursor).toBeNull();
    expect(res.anchors).toEqual([]);
  });
});
