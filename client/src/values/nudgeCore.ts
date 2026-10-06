// Pure helpers behind glslLsp.nudge*: find the number literal under a column
// and increment it by one unit of its last decimal. No `vscode` import.

import { literalDecimals, stepForLiteral } from '../../../shared/valuesMath';

export interface NumberAt {
  /** Column range of the literal INCLUDING a unary minus. */
  start: number;
  end: number;
  /** Literal text without suffix, e.g. `-0.25`. */
  text: string;
  suffix: string;
  integer: boolean;
}

const NUMBER_RE = /(?<![\w.])(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:lf|LF|[fFuU])?(?![\w.])/g;

function isUnaryContext(line: string, minusIndex: number): boolean {
  let i = minusIndex - 1;
  while (i >= 0 && (line[i] === ' ' || line[i] === '\t')) i--;
  if (i < 0) return true;
  const c = line[i];
  if (/[\w)\]]/.test(c)) {
    const word = /(\w+)$/.exec(line.slice(0, i + 1))?.[1] ?? '';
    return word === 'return' || word === 'else' || word === 'case';
  }
  return true;
}

/** Number literal containing or touching `character` on `line`; undefined in comments or when none. */
export function numberAt(line: string, character: number): NumberAt | undefined {
  const comment = line.indexOf('//');
  const limit = comment >= 0 ? comment : line.length;
  if (character > limit) return undefined;
  let best: NumberAt | undefined;
  let bestInside = false;
  const re = new RegExp(NUMBER_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index >= limit) break;
    let start = m.index;
    const end = m.index + m[0].length;
    let negative = false;
    if (start > 0 && line[start - 1] === '-' && isUnaryContext(line, start - 1)) {
      start -= 1;
      negative = true;
    }
    if (character < start || character > end) continue;
    const raw = m[0];
    const sm = /(?:lf|LF|[fFuU])$/.exec(raw);
    const suffix = sm ? sm[0] : '';
    const body = suffix ? raw.slice(0, -suffix.length) : raw;
    const integer = !/[.eE]/.test(body) && !/[fF]/.test(suffix);
    const inside = character > start && character < end;
    if (!best || (inside && !bestInside)) {
      best = { start, end, text: (negative ? '-' : '') + body, suffix, integer };
      bestInside = inside;
    }
  }
  return best;
}

function decimalsOf(step: number): number {
  for (let d = 0; d <= 8; d++) {
    const x = step * 10 ** d;
    if (Math.abs(x - Math.round(x)) < 1e-9) return d;
  }
  return 8;
}

/** New literal text (without suffix) for `text` moved by `direction` * `multiplier` steps. */
export function nudgeLiteral(text: string, integer: boolean, direction: 1 | -1, multiplier = 1): string {
  const value = Number(text);
  if (!Number.isFinite(value)) return text;
  const step = stepForLiteral(text, integer) * multiplier;
  if (integer) {
    const v = Math.round(value + direction * step);
    return String(Object.is(v, -0) ? 0 : v);
  }
  const decimals = Math.min(8, Math.max(1, literalDecimals(text), decimalsOf(step)));
  let s = (value + direction * step).toFixed(decimals);
  if (/^-0\.0*$/.test(s)) s = s.slice(1);
  return s;
}

export interface NudgeResult {
  start: number;
  end: number;
  newText: string;
}

/** Full nudge: column range + replacement (suffix kept), or undefined when no number is there. */
export function nudgeLine(line: string, character: number, direction: 1 | -1, multiplier = 1): NudgeResult | undefined {
  const n = numberAt(line, character);
  if (!n) return undefined;
  let newText = nudgeLiteral(n.text, n.integer, direction, multiplier) + n.suffix;
  // A negative result right after a binary `-`/`+` would write `--` (decrement) or `+-`: keep a space.
  const prev = n.start > 0 ? line[n.start - 1] : '';
  if (newText.startsWith('-') && (prev === '-' || prev === '+')) newText = ' ' + newText;
  return { start: n.start, end: n.end, newText };
}

export interface CursorLine {
  line: number;
  /** Text of the cursor's line. */
  text: string;
  character: number;
}

export interface LineEdit extends NudgeResult {
  line: number;
}

/**
 * Edits for a nudge over every cursor, or undefined when the key should keep
 * its default meaning: no cursor on a number, or several cursors of which
 * some are not on a number (a column selection / Add Cursor run in progress
 * must not switch into nudging half-way down).
 */
export function planNudge(cursors: CursorLine[], direction: 1 | -1, multiplier = 1): LineEdit[] | undefined {
  const edits: LineEdit[] = [];
  const seen = new Set<string>();
  for (const c of cursors) {
    const r = nudgeLine(c.text, c.character, direction, multiplier);
    if (!r) {
      if (cursors.length > 1) return undefined;
      continue;
    }
    const key = `${c.line}:${r.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edits.push({ line: c.line, ...r });
  }
  return edits.length ? edits : undefined;
}

export type NudgeKey = 'up' | 'down' | 'upLarge' | 'downLarge';

/**
 * VS Code's default command on the nudge keys, per platform, run when the
 * key does not nudge so the binding never swallows it:
 *  - Windows: Ctrl+Alt+Up/Down = Add Cursor Above/Below,
 *    Ctrl+Shift+Alt+Up/Down = column select.
 *  - Linux: Add Cursor is Shift+Alt+Up/Down (Ctrl+Alt+Up/Down is not bound by
 *    VS Code), column select is Ctrl+Shift+Alt+Up/Down.
 *  - macOS: neither key is a VS Code default (Add Cursor is Alt+Cmd+Up/Down).
 */
export function nudgeFallback(platform: string, key: NudgeKey): string | undefined {
  const column = key === 'upLarge' ? 'cursorColumnSelectUp' : key === 'downLarge' ? 'cursorColumnSelectDown' : undefined;
  if (platform === 'win32') return column ?? (key === 'up' ? 'editor.action.insertCursorAbove' : 'editor.action.insertCursorBelow');
  if (platform === 'linux') return column;
  return undefined;
}
