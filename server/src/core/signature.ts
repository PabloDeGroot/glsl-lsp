// One-line GLSL renderings of symbols and builtins, shared by hover,
// completion, signature help and document symbols.

import type { BuiltinFunction, BuiltinOverload, BuiltinParam } from '../builtins/types';
import type { FieldSymbol, FunctionSymbol, GlslSymbol, MacroSymbol, ParameterSymbol, TypeRef, VariableSymbol } from './model';

export function typeText(t: TypeRef): string {
  return t.name + (t.array ?? '');
}

/** `in vec2 uv` (array suffix after the name, as usually written). */
export function formatParam(p: ParameterSymbol): string {
  const quals = p.qualifiers.length ? p.qualifiers.join(' ') + ' ' : '';
  return `${quals}${p.type.name}${p.name ? ' ' + p.name : ''}${p.type.array ?? ''}`;
}

/** `float gnoise(vec2 st)` */
export function formatFunction(f: FunctionSymbol): string {
  const quals = f.qualifiers.length ? f.qualifiers.join(' ') + ' ' : '';
  return `${quals}${typeText(f.returnType)} ${f.name}(${f.params.map(formatParam).join(', ')})`;
}

/** Labels of each parameter in formatFunction's output (for signature help). */
export function functionParamLabels(f: FunctionSymbol): string[] {
  return f.params.map(formatParam);
}

export function formatVariable(v: VariableSymbol, withInitializer = true): string {
  if (v.iUniform) {
    const u = v.iUniform;
    let s = `#iUniform ${u.declaredType} ${v.name}`;
    if (u.defaultValue) s += ` = ${u.defaultValue}`;
    if (u.min !== undefined) s += ` in { ${u.min}, ${u.max} }`;
    if (u.step) s += ` step ${u.step}`;
    return s;
  }
  const layout = v.layout ? v.layout + ' ' : '';
  const quals = v.qualifiers.length ? v.qualifiers.join(' ') + ' ' : '';
  let s = `${layout}${quals}${v.type.name} ${v.name}${v.type.array ?? ''}`;
  const isConst = v.qualifiers.includes('const');
  if (withInitializer && v.initializer && (isConst || v.initializer.length <= 60)) {
    const init = v.initializer.replace(/\s+/g, ' ');
    s += ` = ${init.length > 120 ? init.slice(0, 117) + '...' : init}`;
  }
  return s;
}

export function formatField(f: FieldSymbol): string {
  const quals = f.qualifiers.length ? f.qualifiers.join(' ') + ' ' : '';
  return `${quals}${f.type.name} ${f.name}${f.type.array ?? ''}`;
}

export function formatMacro(m: MacroSymbol, maxBody = 160): string {
  const params = m.params ? `(${m.params.join(', ')})` : '';
  const body = m.body.length > maxBody ? m.body.slice(0, maxBody - 3) + '...' : m.body;
  return `#define ${m.name}${params}${body ? ' ' + body : ''}`;
}

/** A GLSL snippet describing any symbol (may be multi-line for structs/blocks). */
export function formatSymbol(s: GlslSymbol): string {
  switch (s.kind) {
    case 'function':
      return formatFunction(s);
    case 'parameter':
      return formatParam(s);
    case 'variable':
      return formatVariable(s);
    case 'field':
      return formatField(s);
    case 'macro':
      return formatMacro(s);
    case 'struct':
      return `struct ${s.name} {\n${s.fields.map((f) => '    ' + formatField(f) + ';').join('\n')}\n}`;
    case 'block': {
      const layout = s.layout ? s.layout + ' ' : '';
      const fields = s.fields.map((f) => '    ' + formatField(f) + ';').join('\n');
      return `${layout}${s.qualifiers.join(' ')} ${s.name} {\n${fields}\n}${s.instanceName ? ' ' + s.instanceName : ''};`;
    }
  }
}

// ---------------------------------------------------------------- builtins

export function formatBuiltinParam(p: BuiltinParam): string {
  return `${p.qualifier && p.qualifier !== 'in' ? p.qualifier + ' ' : ''}${p.type} ${p.name}`;
}

export function formatBuiltinOverload(name: string, o: BuiltinOverload): string {
  return `${o.returnType} ${name}(${o.params.map(formatBuiltinParam).join(', ')})`;
}

export function formatBuiltinFunction(f: BuiltinFunction): string[] {
  return f.overloads.map((o) => formatBuiltinOverload(f.name, o));
}
