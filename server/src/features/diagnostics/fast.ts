// Fast, in-process diagnostics built on the core model only (no external
// tool): unresolved includes, include cycles, parser recovery issues,
// duplicate definitions and undeclared identifiers.
//
// Every check is conservative: a false positive on valid shader code is worse
// than a missed error (glslangValidator catches the rest).

import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import { isKeyword, localsAt, normalizeUri, type FileModel, type FunctionSymbol, type GlslSymbol, type Workspace } from '../../core';
import { hasKnownPrefix, KNOWN_NAMES } from './knownNames';

export const SOURCE = 'glsl-lsp';

export interface FastOptions {
  /** Report undeclared identifiers. Default true. */
  undeclared?: boolean;
  /** Upper bound of undeclared-identifier reports per file. */
  maxUndeclared?: number;
}

export function computeFastDiagnostics(ws: Workspace, uriIn: string, options: FastOptions = {}): Diagnostic[] {
  const uri = normalizeUri(uriIn);
  const model = ws.getModel(uri);
  if (!model) return [];
  const out: Diagnostic[] = [];
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // a check must never break the others
    }
  };
  safe(() => checkIncludes(ws, model, out));
  safe(() => checkSyntax(model, out));
  safe(() => checkDuplicates(ws, model, out));
  if (options.undeclared !== false) safe(() => checkUndeclared(ws, model, out, options.maxUndeclared ?? 200));
  return out;
}

// ---------------------------------------------------------------- includes

function checkIncludes(ws: Workspace, model: FileModel, out: Diagnostic[]) {
  for (const inc of model.includes) {
    if (!inc.resolvedUri) {
      out.push({
        range: inc.pathRange,
        severity: DiagnosticSeverity.Error,
        source: SOURCE,
        code: 'unresolved-include',
        message: `Cannot resolve #include "${inc.path}".`,
        data: { path: inc.path },
      });
      continue;
    }
    const target = inc.resolvedUri;
    const cyclic = target === model.uri || ws.transitiveIncludes(target).includes(model.uri);
    if (cyclic) {
      out.push({
        range: inc.pathRange,
        severity: DiagnosticSeverity.Warning,
        source: SOURCE,
        code: 'include-cycle',
        message: target === model.uri ? 'A file cannot include itself.' : `Include cycle: "${ws.displayPath(target)}" includes this file again.`,
      });
    }
  }
}

// ---------------------------------------------------------------- syntax

function checkSyntax(model: FileModel, out: Diagnostic[]) {
  const seenLines = new Set<number>();
  for (const issue of model.issues) {
    // one syntax problem per line: cascades are noise
    if (seenLines.has(issue.range.start.line)) continue;
    seenLines.add(issue.range.start.line);
    out.push({ range: issue.range, severity: DiagnosticSeverity.Error, source: SOURCE, code: 'syntax', message: issue.message });
  }
}

// ---------------------------------------------------------------- conditionals

type Regions = [number, number][];

function regionsOf(model: FileModel, skipIncludeGuards: boolean): Regions {
  const guards = new Set(model.macros.filter((m) => m.isIncludeGuard).map((m) => m.name));
  const out: Regions = [];
  for (const c of model.conditionals) {
    const first = c.branches[0];
    if (!first) continue;
    if (skipIncludeGuards && first.kind === 'ifndef' && c.macro && guards.has(c.macro)) continue;
    out.push([first.start, c.endif ? c.endif.end : model.text.length]);
  }
  return out;
}

/** Offset ranges of #if groups whose outcome we cannot know (everything but include guards). */
export function uncertainRegions(model: FileModel): Regions {
  return regionsOf(model, true);
}

function inRegions(regions: Regions, offset: number): boolean {
  for (const [s, e] of regions) if (offset >= s && offset <= e) return true;
  return false;
}

// ---------------------------------------------------------------- duplicates

function signatureOf(f: FunctionSymbol): string {
  return `${f.name}(${f.params.map((p) => p.type.name + (p.type.array ?? '')).join(',')})`;
}

function duplicateKey(s: GlslSymbol): string | undefined {
  if (s.kind === 'function') return s.isPrototype ? undefined : 'f:' + signatureOf(s);
  if (s.kind === 'struct') return 's:' + s.name;
  if (s.kind === 'variable' && s.origin === 'declaration' && s.storage === 'global') return 'v:' + s.name;
  return undefined;
}

function checkDuplicates(ws: Workspace, model: FileModel, out: Diagnostic[]) {
  const mine = regionsOf(model, false);
  // Unguarded definitions of included files (anything inside #if/#ifndef may be an alternative).
  const others = new Map<string, GlslSymbol>();
  for (const u of ws.transitiveIncludes(model.uri)) {
    const m = ws.getModel(u);
    if (!m || m === model) continue;
    const regions = regionsOf(m, false);
    for (const s of m.symbols) {
      const key = duplicateKey(s);
      if (!key || !s.name || inRegions(regions, s.nameOffset)) continue;
      if (!others.has(key)) others.set(key, s);
    }
  }
  const seen = new Map<string, GlslSymbol>();
  for (const s of model.symbols) {
    const key = duplicateKey(s);
    if (!key || !s.name || inRegions(mine, s.nameOffset)) continue;
    const prev = seen.get(key) ?? others.get(key);
    if (!prev) {
      seen.set(key, s);
      continue;
    }
    const line = prev.nameRange.start.line + 1;
    const where = prev.uri === model.uri ? `line ${line}` : `${ws.displayPath(prev.uri)}:${line}`;
    const label = s.kind === 'function' ? `function '${signatureOf(s)}'` : `${s.kind} '${s.name}'`;
    out.push({
      range: s.nameRange,
      severity: DiagnosticSeverity.Error,
      source: SOURCE,
      code: 'duplicate-definition',
      message: `Duplicate definition of ${label}; already defined at ${where}.`,
      relatedInformation: [{ location: { uri: prev.uri, range: prev.nameRange }, message: 'Previous definition' }],
    });
  }
}

// ---------------------------------------------------------------- undeclared

/**
 * Names that macros in scope might declare (any identifier inside a macro
 * body containing `;` or `{`). `undefined` means "give up": token pasting
 * (`##`) can invent arbitrary names.
 */
function macroGeneratedNames(models: FileModel[]): Set<string> | undefined {
  const names = new Set<string>();
  const declaring = new Set<string>();
  for (const m of models) {
    for (const mac of m.macros) {
      const body = mac.body ?? '';
      if (body.includes('##')) return undefined;
      if (body.includes(';') || body.includes('{')) {
        declaring.add(mac.name);
        for (const w of body.match(/[A-Za-z_]\w*/g) ?? []) names.add(w);
      }
    }
  }
  // Arguments of invocations of declaring macros (`DECL(float, name)`) may become declarations.
  if (declaring.size) {
    for (const m of models) {
      for (const call of m.calls) {
        if (!declaring.has(call.name)) continue;
        const from = m.lines.offsetAt(call.range.start);
        const to = m.lines.offsetAt(call.range.end);
        for (const o of m.occurrences) if (o.start >= from && o.end <= to) names.add(o.name);
      }
    }
  }
  return names;
}

function checkUndeclared(ws: Workspace, model: FileModel, out: Diagnostic[], max: number) {
  const files = [model, ...ws.transitiveIncludes(model.uri).map((u) => ws.getModel(u)).filter((m): m is FileModel => !!m)];
  const generated = macroGeneratedNames(files);
  if (!generated) return;
  const declared = new Set<string>();
  for (const m of files) {
    for (const s of m.symbols) if (s.name) declared.add(s.name);
    for (const b of m.blocks) if (!b.instanceName) for (const f of b.fields) declared.add(f.name);
  }
  const uncertain = uncertainRegions(model);
  let reported = 0;

  for (const occ of model.occurrences) {
    if (reported >= max) break;
    if (occ.role !== 'reference' && occ.role !== 'call' && occ.role !== 'type') continue;
    const name = occ.name;
    if (declared.has(name) || KNOWN_NAMES.has(name) || generated.has(name) || hasKnownPrefix(name) || isKeyword(name)) continue;
    if (inRegions(uncertain, occ.start)) continue;
    if (localsAt(model, occ.start).some((s) => s.name === name)) continue;
    if (ws.builtins.get(name)) continue; // any builtin, even one hidden by a directive filter

    const definedIn = ws.findDeclaringFiles(name);
    const isError = definedIn.length > 0;
    const hint = isError
      ? ` It is declared in ${ws.displayPath(definedIn[0])}${definedIn.length > 1 ? ` (and ${definedIn.length - 1} more)` : ''}, which this file does not include.`
      : '';
    out.push({
      range: occ.range,
      severity: isError ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
      source: SOURCE,
      code: 'undeclared-identifier',
      message: `Undeclared identifier '${name}'.${hint}`,
      data: { name },
    });
    reported++;
  }
}
