// Shared helpers of the values.server.* tests.
import { computeValueTargets, type ValuesEnv } from '../server/src/features/values/targets';
import type { PinAnchor, ValueTarget, ValueTargetsResult } from '../shared/valuesProtocol';
import { cursor, makeWorkspace, uri } from './helpers';

export function makeEnv(files: Record<string, string>, mode: 'heuristic' | 'all' | 'off' = 'heuristic') {
  const { ws } = makeWorkspace(files);
  const env: ValuesEnv = {
    getModel: (u) => ws.getModel(u),
    getVersion: () => 1,
    workspace: ws,
    colorsMode: mode,
  };
  return { env, ws };
}

/** Runs the cursor request on `src` with a `|` marker; extra files are other workspace files. */
export function at(src: string, extra: Record<string, string> = {}, mode: 'heuristic' | 'all' | 'off' = 'heuristic') {
  const c = cursor(src);
  const { env } = makeEnv({ 'main.glsl': c.text, ...extra }, mode);
  const res = computeValueTargets(env, { uri: uri('main.glsl'), position: c.position });
  return { t: res.cursor ?? null, text: c.text, env };
}

/** Source text covered by a target's range. */
export function textOf(text: string, t: ValueTarget | null | undefined): string | undefined {
  if (!t) return undefined;
  const lines = text.split('\n');
  const { start, end } = t.range;
  if (start.line === end.line) return lines[start.line].slice(start.character, end.character);
  return lines
    .slice(start.line, end.line + 1)
    .map((l, i, all) => (i === 0 ? l.slice(start.character) : i === all.length - 1 ? l.slice(0, end.character) : l))
    .join('\n');
}

/** Resolves anchors against `text` (as main.glsl). */
export function resolve(text: string, anchors: PinAnchor[], extra: Record<string, string> = {}): ValueTargetsResult {
  const { env } = makeEnv({ 'main.glsl': text, ...extra });
  return computeValueTargets(env, { uri: uri('main.glsl'), anchors });
}

export function anchorAt(src: string): { anchor: PinAnchor; target: ValueTarget } {
  const r = at(src);
  if (!r.t) throw new Error('no target at cursor');
  return { anchor: r.t.anchor, target: r.t };
}
