// Pin anchor resolution: declaration (by name) -> exact line fingerprint ->
// fuzzy fingerprint -> none. See docs/VALUES.md "Pin anchoring".

import type { AnchorResolution, PinAnchor, ValueTarget } from '../../../../shared/valuesProtocol';
import { lineFingerprint } from '../../../../shared/valuesMath';
import { functionAt, multiGroups, stmtEnd } from './analysis';
import { statementName } from './labels';
import { anchorText, buildMulti, buildTarget, isDeclKind, neighbourFingerprint } from './build';
import type { Analysis, MultiGroup, Spec, ValuesEnv } from './types';

const FUZZY_WINDOW = 200;
const FUZZY_MIN = 0.75;
/** Minimum line-match score (see `scored` in resolveAnchor). */
const MIN_SCORE = 3;
/** ...when the line is the only one of its exact fingerprint. */
const MIN_SCORE_UNIQUE = 1.5;

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length > 300) a = a.slice(0, 300);
  if (b.length > 300) b = b.slice(0, 300);
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m;
}

type Hit = { spec: Spec; group?: undefined } | { group: MultiGroup; spec?: undefined };

export function resolveAnchor(env: ValuesEnv, a: Analysis, anchor: PinAnchor): AnchorResolution {
  const model = a.model;
  const build = (h: Hit): ValueTarget => (h.group ? buildMulti(env, a, h.group) : buildTarget(env, a, h.spec));
  const ok = (h: Hit | undefined, match: AnchorResolution['match']): AnchorResolution | undefined => {
    if (!h) return undefined;
    const target = build(h);
    return { target, anchor: target.anchor, match };
  };

  // 1. declaration. An array element (`lut[5]`) is named by its position, so
  // after elements were inserted or removed its index names another entry:
  // trust it only with the same text, else match lines like a statement.
  const element = elementBase(anchor.declName);
  if (anchor.declName && isDeclKind(anchor.declKind)) {
    const r = ok(byDeclaration(env, a, anchor), 'declaration');
    const sameText = () => !!r?.target && anchorText(a, model.lines.offsetAt(r.target.range.start), model.lines.offsetAt(r.target.range.end)) === anchor.text;
    if (r && (!element || anchor.text === undefined || sameText())) return r;
  }

  // Lines holding a candidate of the anchor's kind.
  const lineHits = new Map<number, Hit[]>();
  if (anchor.kind === 'multi') {
    for (const g of multiGroups(a)) {
      const line = model.lines.lineAt(a.seq[g.from].start);
      const l = lineHits.get(line);
      if (l) l.push({ group: g });
      else lineHits.set(line, [{ group: g }]);
    }
  } else {
    for (const [line, specs] of a.byLine) {
      const hits = specs.filter((s) => s.kind === anchor.kind).map((spec): Hit => ({ spec }));
      if (hits.length) lineHits.set(line, hits);
    }
  }

  const fps = new Map<number, string>();
  const fp = (line: number) => {
    let f = fps.get(line);
    if (f === undefined) {
      f = lineFingerprint(model.lines.lineText(line));
      fps.set(line, f);
    }
    return f;
  };
  const pick = (hits: Hit[]) => hits[Math.min(Math.max(0, anchor.ordinal), hits.length - 1)];

  // A line match must not hijack another named declaration: a pin on
  // `#iUniform float u_speed` whose line was deleted must go stale, not jump
  // to the neighbouring `u_zoom` (whose fingerprint is almost identical).
  const foreign = (t: ValueTarget) =>
    !!anchor.declName &&
    isDeclKind(anchor.declKind) &&
    t.declKind === anchor.declKind &&
    !!t.name &&
    t.name !== anchor.declName &&
    (!element || elementBase(t.name) !== element);
  const byDistance = (x: number, y: number) => Math.abs(x - anchor.line) - Math.abs(y - anchor.line);

  // Anchors written before text/context existed: nearest line wins (old behaviour).
  const legacy = anchor.text === undefined;
  const tryLegacy = (lines: number[], match: AnchorResolution['match']): AnchorResolution | undefined => {
    for (const line of lines) {
      const r = ok(pick(lineHits.get(line)!), match);
      if (r?.target && !foreign(r.target)) return r;
    }
    return undefined;
  };

  /**
   * Scored line matching. Many lines share a fingerprint (LUT entries,
   * `col *= #;`, fbm variants), so the nearest one is not good enough:
   *   same source text +2, same previous / next line fingerprint +1 each,
   *   same line +1 (within 3 lines +0.5); another function is never a match.
   * A candidate needs MIN_SCORE (same line + both neighbours, or the text
   * plus some context); a tie between equally near lines is ambiguous, and
   * an ambiguous or weak match makes the pin stale rather than retarget it.
   * `strict` (the client saw the pinned line removed) requires the text.
   */
  const scored = (lines: number[], match: AnchorResolution['match']): AnchorResolution | undefined => {
    const cands: { r: AnchorResolution; score: number; dist: number }[] = [];
    for (const line of lines) {
      const r = ok(pick(lineHits.get(line)!), match);
      const t = r?.target;
      if (!r || !t || foreign(t)) continue;
      if (anchor.functionName && t.functionName !== anchor.functionName) continue;
      const textHit = anchorText(a, model.lines.offsetAt(t.range.start), model.lines.offsetAt(t.range.end)) === anchor.text;
      if (anchor.strict && !textHit) continue;
      const dist = Math.abs(line - anchor.line);
      let score = textHit ? 2 : 0;
      if (anchor.prevFingerprint !== undefined && neighbourFingerprint(a, line, -1) === anchor.prevFingerprint) score += 1;
      if (anchor.nextFingerprint !== undefined && neighbourFingerprint(a, line, 1) === anchor.nextFingerprint) score += 1;
      score += dist === 0 ? 1 : dist <= 3 ? 0.5 : 0;
      cands.push({ r, score, dist });
    }
    // The only line of that exact shape needs less evidence than one of several look-alikes.
    const min = match === 'fingerprint' && cands.length === 1 ? MIN_SCORE_UNIQUE : MIN_SCORE;
    let best: (typeof cands)[number] | undefined;
    let tie = false;
    for (const c of cands) {
      if (c.score < min) continue;
      if (!best || c.score > best.score || (c.score === best.score && c.dist < best.dist)) {
        tie = false;
        best = c;
      } else if (c.score === best.score && c.dist === best.dist) tie = true;
    }
    return best && !tie ? best.r : undefined;
  };
  const tryLines = legacy ? tryLegacy : scored;

  // 2. exact fingerprint, nearest line first
  const exact = [...lineHits.keys()].filter((line) => fp(line) === anchor.fingerprint).sort(byDistance);
  const exactHit = tryLines(exact, 'fingerprint');
  if (exactHit) return exactHit;

  // 3. fuzzy fingerprint: best similarity first, then nearest
  const fuzzy: { line: number; score: number }[] = [];
  for (const line of lineHits.keys()) {
    if (Math.abs(line - anchor.line) > FUZZY_WINDOW) continue;
    if (fp(line) === anchor.fingerprint && !legacy) continue; // already scored above
    const score = similarity(fp(line), anchor.fingerprint);
    if (score >= FUZZY_MIN) fuzzy.push({ line, score });
  }
  fuzzy.sort((x, y) => y.score - x.score || byDistance(x.line, y.line));
  const fuzzyHit = tryLines(
    fuzzy.map((f) => f.line),
    'fuzzy',
  );
  if (fuzzyHit) return fuzzyHit;
  return { target: null, anchor, match: 'none' };
}

/** `lut` for an array element name `lut[5]`, else undefined. */
function elementBase(name: string | undefined): string | undefined {
  const m = name ? /^(\w+)\[\d+\]$/.exec(name) : null;
  return m ? m[1] : undefined;
}

/** Finds the declaration named by the anchor and returns its initializer target. */
function byDeclaration(env: ValuesEnv, a: Analysis, anchor: PinAnchor): Hit | undefined {
  const seq = a.seq;
  const cands: Hit[] = [];
  if (anchor.declKind === 'iUniform' || anchor.declKind === 'define') {
    const want = anchor.declKind;
    a.dirs.forEach((d, idx) => {
      if (d.name !== anchor.declName || d.kind !== want) return;
      if (anchor.kind === 'multi') {
        const g = multiGroups(a).find((x) => seq[x.from].region === idx);
        if (g) cands.push({ group: g });
        return;
      }
      const inDir = a.specs.filter((s) => s.top && seq[s.startTok].region === idx);
      if (inDir.length === 1 && inDir[0].kind === anchor.kind) cands.push({ spec: inDir[0] });
    });
  } else if (anchor.kind === 'multi') {
    // `float sum = 0.0, amp = 0.5, norm = 0.0;` anchored by its first declared name.
    for (const g of multiGroups(a)) {
      if (seq[g.from].region !== -1) continue;
      const sn = statementName(a, g.from, g.to);
      if (sn.name !== anchor.declName || sn.declKind !== anchor.declKind) continue;
      if (anchor.functionName && functionAt(a, seq[g.from].start) !== anchor.functionName) continue;
      cands.push({ group: g });
    }
  } else if (/^\w+\[\d+\]$/.test(anchor.declName ?? '')) {
    // Array element `lut[5]` of `const vec3 lut[17] = vec3[17](...)`.
    const base = anchor.declName!.slice(0, anchor.declName!.indexOf('['));
    for (let i = 0; i < seq.length - 2; i++) {
      const t = seq[i];
      if (t.kind !== 'ident' || t.text !== base || t.region !== -1) continue;
      let j = i + 1;
      while (seq[j]?.text === '[' && a.match[j] > j) j = a.match[j] + 1;
      if (seq[j]?.text !== '=') continue;
      const end = stmtEnd(seq, j);
      for (const spec of a.specs) {
        if (spec.startTok <= j) continue;
        if (spec.startTok >= end) break;
        if (spec.kind !== anchor.kind || !spec.top) continue;
        if (anchor.functionName && functionAt(a, spec.start) !== anchor.functionName) continue;
        if (buildTarget(env, a, spec).name === anchor.declName) cands.push({ spec });
      }
    }
  } else {
    for (let i = 0; i < seq.length - 2; i++) {
      const t = seq[i];
      if (t.kind !== 'ident' || t.text !== anchor.declName || t.region !== -1) continue;
      let j = i + 1;
      while (seq[j]?.text === '[' && a.match[j] > j) j = a.match[j] + 1;
      if (seq[j]?.text !== '=') continue;
      const spec = a.specByStart.get(j + 1);
      if (!spec || spec.kind !== anchor.kind || !spec.top) continue;
      if (anchor.functionName && functionAt(a, spec.start) !== anchor.functionName) continue;
      cands.push({ spec });
    }
  }
  let best: { hit: Hit; dist: number } | undefined;
  for (const hit of cands) {
    if (hit.spec && !(anchor.declKind === 'iUniform' || anchor.declKind === 'define')) {
      // Only real declarations with the initializer as the whole value count.
      const t = buildTarget(env, a, hit.spec);
      if (t.name !== anchor.declName || !isDeclKind(t.declKind)) continue;
    }
    const start = hit.spec ? hit.spec.start : seq[hit.group.from].start;
    const dist = Math.abs(a.model.lines.lineAt(start) - anchor.line);
    if (!best || dist < best.dist) best = { hit, dist };
  }
  return best?.hit;
}
