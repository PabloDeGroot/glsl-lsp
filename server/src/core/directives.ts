// Preprocessor directive scanning. Works on the `directive` tokens produced
// by the lexer and extracts: #include, #define (object- and function-like
// macros), conditional groups, #version, and the shader-toy extension
// directives (#iChannelN, #iUniform, #iKeyboard).
//
// Conditions are NOT evaluated: every branch is parsed, which is what an
// editor wants (all code is navigable).

import { docAbove, trailingDoc } from './docs';
import { isKeyword } from './keywords';
import { lex, type Token } from './lexer';
import type {
  ConditionalBlock,
  Directive,
  DirectiveKind,
  IncludeDirective,
  IUniformInfo,
  MacroSymbol,
  Occurrence,
  ShadertoyInfo,
  VariableSymbol,
} from './model';
import type { LineIndex, Range } from './text';

export interface DirectiveScan {
  directives: Directive[];
  includes: IncludeDirective[];
  conditionals: ConditionalBlock[];
  macros: MacroSymbol[];
  /** #iUniform / #iChannel-derived globals. */
  globals: VariableSymbol[];
  occurrences: Occurrence[];
  glslVersion?: { number: number; profile?: string; range: Range };
  shadertoy: Omit<ShadertoyInfo, 'hasMainImage'>;
}

const KIND_BY_NAME: Record<string, DirectiveKind> = {
  include: 'include',
  define: 'define',
  undef: 'undef',
  if: 'if',
  ifdef: 'ifdef',
  ifndef: 'ifndef',
  elif: 'elif',
  else: 'else',
  endif: 'endif',
  version: 'version',
  extension: 'extension',
  pragma: 'pragma',
  line: 'line',
  error: 'error',
  iKeyboard: 'iKeyboard',
  iUniform: 'iUniform',
};

/** Shader-toy `#iUniform` types mapped to GLSL types. */
const IUNIFORM_TYPES: Record<string, string> = {
  color3: 'vec3',
  color4: 'vec4',
};

export function directiveKind(name: string): DirectiveKind {
  if (/^iChannel\d/.test(name)) return 'iChannel';
  return KIND_BY_NAME[name] ?? 'other';
}

export function scanDirectives(uri: string, tokens: readonly Token[], lines: LineIndex): DirectiveScan {
  const scan: DirectiveScan = {
    directives: [],
    includes: [],
    conditionals: [],
    macros: [],
    globals: [],
    occurrences: [],
    shadertoy: { channels: [], keyboard: false, directives: false },
  };
  const stack: ConditionalBlock[] = [];

  const occ = (name: string, start: number, role: Occurrence['role']): Occurrence => {
    const o: Occurrence = { name, role, start, end: start + name.length, range: lines.range(start, start + name.length) };
    scan.occurrences.push(o);
    return o;
  };

  /** Records identifier references in a directive's argument text. */
  const referenceIdents = (text: string, base: number, exclude?: Set<string>) => {
    let prev: Token | undefined;
    for (const t of lex(text, { baseOffset: base, directives: false })) {
      const afterDot = prev?.text === '.';
      if (t.kind !== 'lineComment' && t.kind !== 'blockComment') prev = t;
      // `r.time` in a macro body: a field or swizzle, never a global name.
      if (afterDot || t.kind !== 'ident' || t.text === 'defined' || isKeyword(t.text) || exclude?.has(t.text)) continue;
      occ(t.text, t.start, 'directive');
    }
  };

  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];
    if (tok.kind !== 'directive') continue;
    const text = tok.text;
    const nameMatch = /^#\s*([A-Za-z_]\w*(?:::\w+)?)?/.exec(text)!;
    const name = nameMatch[1] ?? '';
    const kind = directiveKind(name.replace(/::.*$/, ''));
    let argsStart = nameMatch[0].length;
    while (argsStart < text.length && /\s/.test(text[argsStart])) argsStart++;
    // Strip inline block comments from args for interpretation, keep offsets for ranges.
    const rawArgs = text.slice(argsStart);
    const args = rawArgs.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)).trimEnd();
    const argsBase = tok.start + argsStart;
    const directive: Directive = {
      kind,
      name,
      args: args.trim(),
      range: lines.range(tok.start, tok.end),
      start: tok.start,
      end: tok.end,
      tokenIndex: ti,
    };
    scan.directives.push(directive);

    switch (kind) {
      case 'include': {
        const m = /^(["<])([^">]*)[">]?/.exec(args);
        if (m) {
          const pathStart = argsBase + 1;
          scan.includes.push({
            path: m[2],
            pathRange: lines.range(pathStart, pathStart + m[2].length),
            range: directive.range,
            ...(m[1] === '<' ? { angle: true } : {}),
          });
        }
        break;
      }
      case 'define': {
        const m = /^([A-Za-z_]\w*)(\(([^)]*)\)?)?/.exec(args);
        if (!m) break;
        const macroName = m[1];
        const nameStart = argsBase;
        const params = m[2] !== undefined ? (m[3] ?? '').split(',').map((p) => p.trim()).filter(Boolean) : undefined;
        const bodyOffset = m[0].length;
        const body = args.slice(bodyOffset).replace(/\\\s*(\r\n|\r|\n)/g, ' ').replace(/\s+/g, ' ').trim();
        const prev = scan.directives[scan.directives.length - 2];
        const guardedBy =
          prev && (prev.kind === 'ifndef' || prev.kind === 'if') && new RegExp(`\\b${macroName}\\b`).test(prev.args) ? prev : undefined;
        const symbol: MacroSymbol = {
          kind: 'macro',
          name: macroName,
          uri,
          range: directive.range,
          nameRange: lines.range(nameStart, nameStart + macroName.length),
          nameOffset: nameStart,
          params,
          body,
          isIncludeGuard: false,
          origin: 'define',
        };
        symbol.doc =
          docAbove(tokens, ti, lines) ??
          (guardedBy ? docAbove(tokens, guardedBy.tokenIndex, lines) : undefined) ??
          trailingDoc(tokens, ti, lines, 'directive');
        // Guard heuristic part 1: empty body right after `#ifndef NAME` (finished below).
        if (!body && guardedBy) symbol.isIncludeGuard = true;
        scan.macros.push(symbol);
        const o = occ(macroName, nameStart, 'declaration');
        o.symbol = symbol;
        referenceIdents(args.slice(bodyOffset), argsBase + bodyOffset, new Set(params ?? []));
        break;
      }
      case 'undef':
      case 'ifdef':
      case 'ifndef':
      case 'if':
      case 'elif':
        referenceIdents(args, argsBase);
        break;
      case 'version': {
        const m = /^(\d+)\s*(\w+)?/.exec(args);
        if (m) scan.glslVersion = { number: Number(m[1]), profile: m[2], range: directive.range };
        break;
      }
      case 'iKeyboard':
        scan.shadertoy.keyboard = true;
        scan.shadertoy.directives = true;
        break;
      case 'iChannel': {
        scan.shadertoy.directives = true;
        const m = /^iChannel(\d)$/.exec(name);
        const src = /^"([^"]*)"/.exec(args);
        if (m && src) scan.shadertoy.channels.push({ index: Number(m[1]), source: src[1], range: directive.range });
        break;
      }
      case 'iUniform': {
        scan.shadertoy.directives = true;
        const sym = parseIUniform(uri, args, argsBase, lines, directive.range);
        if (sym) {
          sym.doc = docAbove(tokens, ti, lines) ?? trailingDoc(tokens, ti, lines, 'directive');
          scan.globals.push(sym);
          const o = occ(sym.name, sym.nameOffset, 'declaration');
          o.symbol = sym;
        }
        break;
      }
    }

    // Conditional groups.
    if (kind === 'if' || kind === 'ifdef' || kind === 'ifndef') {
      const block: ConditionalBlock = { branches: [directive] };
      if (kind !== 'if') block.macro = /^\w+/.exec(directive.args)?.[0];
      else block.macro = /^!\s*defined\s*\(?\s*(\w+)/.exec(directive.args)?.[1];
      stack.push(block);
      scan.conditionals.push(block);
    } else if (kind === 'elif' || kind === 'else') {
      stack[stack.length - 1]?.branches.push(directive);
    } else if (kind === 'endif') {
      const block = stack.pop();
      if (block) {
        block.branches.push(directive);
        block.endif = directive;
      }
    }
  }

  // Guard heuristic part 2: keep the guard flag only when the group wraps
  // the rest of the file or the name looks like a guard (FNC_X, X_H, ...).
  for (const macro of scan.macros) {
    if (!macro.isIncludeGuard) continue;
    if (/^(FNC_|STR_|HEADER_)|_(H|GLSL|INCLUDED|GUARD)$/.test(macro.name)) continue;
    const block = scan.conditionals.find((b) => b.macro === macro.name && b.branches[0].start < macro.nameOffset);
    const lastToken = lastNonComment(tokens);
    macro.isIncludeGuard = !!block?.endif && !!lastToken && block.endif.start >= lastToken.start;
  }
  return scan;
}

function lastNonComment(tokens: readonly Token[]): Token | undefined {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].kind !== 'lineComment' && tokens[i].kind !== 'blockComment') return tokens[i];
  }
  return undefined;
}

/** `float u_speed = 1.0 in { 0.0, 4.0 } step 0.1` -> uniform variable symbol. */
function parseIUniform(uri: string, args: string, base: number, lines: LineIndex, directiveRange: Range): VariableSymbol | undefined {
  const m = /^(\w+)\s+([A-Za-z_]\w*)/.exec(args);
  if (!m) return undefined;
  const declaredType = m[1];
  const name = m[2];
  const nameStart = base + m[0].length - name.length;
  const info: IUniformInfo = { declaredType };
  const rest = args.slice(m[0].length);
  // Cut at ` in {` / ` step` with a single-whitespace search: a lazy `(.*?)` before `\s+in` is quadratic on long lines.
  const eq = /^\s*=/.exec(rest);
  if (eq) {
    const cut = rest.search(/\s(?:in\s*\{|step\b)/);
    info.defaultValue = rest.slice(eq[0].length, cut > eq[0].length ? cut : undefined).trim();
  }
  // No `\s*` next to the groups: they match spaces too, and the ambiguity backtracks cubically on a long unclosed `in {`.
  const range = /\bin\s*\{([^,}]*),([^}]*)\}/.exec(rest);
  if (range) {
    info.min = range[1].trim();
    info.max = range[2].trim();
  }
  const step = /\bstep\s+(\S+)/.exec(rest);
  if (step) info.step = step[1];
  return {
    kind: 'variable',
    name,
    uri,
    range: directiveRange,
    nameRange: lines.range(nameStart, nameStart + name.length),
    nameOffset: nameStart,
    type: { name: IUNIFORM_TYPES[declaredType] ?? declaredType },
    qualifiers: ['uniform'],
    storage: 'global',
    iUniform: info,
    initializer: info.defaultValue,
    origin: 'iUniform',
  };
}
