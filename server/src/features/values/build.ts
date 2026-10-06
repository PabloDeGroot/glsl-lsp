// Turns detection specs into protocol ValueTargets (names, components,
// colorish, snippets and pin anchors).

import type { DeclKind, PinAnchor, ValueComponent, ValueTarget } from '../../../../shared/valuesProtocol';
import { lineFingerprint } from '../../../../shared/valuesMath';
import { multiGroups } from './analysis';
import { clip, collapse, contextOf, isColorish, statementName, windowSnippet, type Ctx } from './labels';
import type { Analysis, MultiGroup, Spec, ValuesEnv } from './types';

const DECL_KINDS = new Set<DeclKind>(['iUniform', 'const', 'global', 'local', 'define']);
const PALETTE_NAMES = ['a', 'b', 'c', 'd'];

export function isDeclKind(k: DeclKind | undefined): boolean {
  return !!k && DECL_KINDS.has(k);
}

/** Fingerprint of the nearest non-blank line before (dir -1) / after (dir 1) `line`, '' at the file edge. */
export function neighbourFingerprint(a: Analysis, line: number, dir: -1 | 1): string {
  const n = a.model.lines.lineCount;
  for (let l = line + dir, k = 0; l >= 0 && l < n && k < 8; l += dir, k++) {
    const f = lineFingerprint(a.model.lines.lineText(l));
    if (f) return f;
  }
  return '';
}

/** Whitespace-collapsed source text of a target (anchor identity), capped. */
export function anchorText(a: Analysis, start: number, end: number): string {
  return collapse(a.model.text.slice(start, Math.min(end, start + 400)));
}

function anchorFor(a: Analysis, kind: PinAnchor['kind'], start: number, end: number, ordinal: number, ctx: Ctx): PinAnchor {
  const pos = a.model.lines.positionAt(start);
  const anchor: PinAnchor = {
    uri: a.model.uri,
    kind,
    fingerprint: lineFingerprint(a.model.lines.lineText(pos.line)),
    line: pos.line,
    character: pos.character,
    ordinal,
    text: anchorText(a, start, end),
    prevFingerprint: neighbourFingerprint(a, pos.line, -1),
    nextFingerprint: neighbourFingerprint(a, pos.line, 1),
  };
  if (isDeclKind(ctx.declKind) && ctx.name) {
    anchor.declName = ctx.name;
    anchor.declKind = ctx.declKind;
  }
  // Always: two functions often hold statements of the same shape (fbm variants).
  if (ctx.functionName) anchor.functionName = ctx.functionName;
  return anchor;
}

function ordinalOf(a: Analysis, spec: Spec): number {
  const line = a.model.lines.lineAt(spec.start);
  let n = 0;
  for (const s of a.byLine.get(line) ?? []) if (s !== spec && s.kind === spec.kind && s.start < spec.start) n++;
  return n;
}

export interface BuildOptions {
  /** Overrides name/declKind (palette children). */
  name?: string;
  declKind?: DeclKind;
}

export function buildTarget(env: ValuesEnv, a: Analysis, spec: Spec, opts: BuildOptions = {}): ValueTarget {
  const model = a.model;
  const seq = a.seq;
  const ctx: Ctx = contextOf(env, a, spec.startTok, spec.endTok);
  if (opts.name !== undefined) ctx.name = opts.name;
  if (opts.declKind) ctx.declKind = opts.declKind;
  const range = model.lines.range(spec.start, spec.end);
  const text = model.text.slice(spec.start, spec.end);

  let components: ValueComponent[] = [];
  let children: ValueTarget[] | undefined;
  let ctor: string | undefined;
  let splat: boolean | undefined;
  let paletteShape: ValueTarget['paletteShape'];

  if (spec.implicit) {
    ctor = 'vec3';
    splat = true;
    components = [{ range: model.lines.range(spec.start, spec.start), value: 1, text: '1.0', editable: false }];
  } else if (spec.lit) {
    const l = spec.lit;
    const c: ValueComponent = { range, value: l.value, text: l.text, editable: true };
    if (l.integer) c.integer = true;
    components = [c];
  } else if (spec.vec) {
    const v = spec.vec;
    ctor = v.ctor;
    if (v.splat) splat = true;
    components = v.args.map((arg): ValueComponent => {
      if (arg.lit) {
        const c: ValueComponent = {
          range: model.lines.range(arg.lit.start, arg.lit.end),
          value: arg.lit.value,
          text: arg.lit.text,
          editable: true,
        };
        if (arg.lit.integer) c.integer = true;
        return c;
      }
      const s = seq[arg.from].start;
      const e = seq[arg.to - 1].end;
      return { range: model.lines.range(s, e), value: NaN, text: model.text.slice(s, e), editable: false };
    });
  } else if (spec.palette) {
    paletteShape = spec.palette.shape;
    children = spec.palette.children.map((c, i) => buildTarget(env, a, c, { name: PALETTE_NAMES[i], declKind: 'argument' }));
  }

  const colorish = isColorish(
    a,
    env.colorsMode,
    spec,
    ctx,
    components.map((c) => ({ value: c.value, editable: c.editable })),
  );
  const snippet = ctx.name || spec.kind === 'palette' ? clip(text) : windowSnippet(model.text, spec.start, spec.end);

  const t: ValueTarget = {
    id: `${spec.kind}:${range.start.line}:${range.start.character}`,
    kind: spec.kind,
    uri: model.uri,
    version: env.getVersion(model.uri),
    declKind: ctx.declKind,
    snippet,
    anchor: anchorFor(a, spec.kind, spec.start, spec.end, ordinalOf(a, spec), ctx),
    range,
    components,
    colorish,
  };
  if (ctx.name) t.name = ctx.name;
  if (ctx.functionName) t.functionName = ctx.functionName;
  if (ctor) t.ctor = ctor;
  if (splat) t.splat = true;
  if (ctx.uniform) t.uniform = ctx.uniform;
  if (children) t.children = children;
  if (paletteShape) t.paletteShape = paletteShape;
  if (spec.implicit) {
    t.implicit = true;
    t.snippet = 'vec3(1.0) (implicit)';
  }
  return t;
}

export function buildMulti(env: ValuesEnv, a: Analysis, group: MultiGroup, cursorOffset?: number): ValueTarget {
  const model = a.model;
  const seq = a.seq;
  const start = seq[group.from].start;
  const end = seq[group.to - 1].end;
  const range = model.lines.range(start, end);
  const sn = statementName(a, group.from, group.to);
  const functionName = a.fns.length ? a.fns.find((f) => f.start <= start && start <= f.end)?.name : undefined;
  const ctx: Ctx = { name: sn.name, declKind: sn.declKind, functionName };
  const children = group.children.map((c) => buildTarget(env, a, c));
  disambiguateNames(children);
  const line = range.start.line;
  const groups = multiGroups(a).filter((g) => model.lines.lineAt(seq[g.from].start) === line);
  const ordinal = Math.max(0, groups.indexOf(group));
  const t: ValueTarget = {
    id: `multi:${line}:${range.start.character}`,
    kind: 'multi',
    uri: model.uri,
    version: env.getVersion(model.uri),
    declKind: sn.declKind,
    snippet: clip(collapse(model.text.slice(start, end))),
    anchor: anchorFor(a, 'multi', start, end, ordinal, ctx),
    range,
    components: [],
    colorish: false,
    children,
  };
  if (sn.name) t.name = sn.name;
  if (functionName) t.functionName = functionName;
  if (cursorOffset !== undefined && group.children.length) {
    let best = 0;
    let bestD = Infinity;
    group.children.forEach((c, i) => {
      const d = cursorOffset < c.start ? c.start - cursorOffset : cursorOffset > c.end ? cursorOffset - c.end : 0;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    t.activeChild = best;
  }
  return t;
}

/**
 * Sibling sub-rows must be told apart: children sharing a name (`col`, `col`,
 * `col · sin`, `col · sin`) get ` #1`, ` #2`, ... in source order.
 */
export function disambiguateNames(children: ValueTarget[]): void {
  const count = new Map<string, number>();
  for (const c of children) if (c.name) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const c of children) {
    if (!c.name || (count.get(c.name) ?? 0) < 2) continue;
    const k = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, k);
    c.name = `${c.name} #${k}`;
  }
}
