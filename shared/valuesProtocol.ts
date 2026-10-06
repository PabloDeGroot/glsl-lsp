// Shared contract of the "Values" side panel (see docs/VALUES.md).
//
// Three parties import this file:
//   - the language server   (server/src/features/values*.ts) answers VALUE_TARGETS_REQUEST,
//   - the extension client  (client/src/values/*) owns pins, cursor tracking and edits,
//   - the webview           (webview/src/*) draws the list and the widgets.
//
// It must stay PURE: no imports from `vscode`, `vscode-languageserver`, node or
// the DOM, so it typechecks under every tsconfig. Types only, plus a few tiny
// constants and type guards. Ranges are LSP-shaped (zero-based line/UTF-16
// character, half-open) and structurally identical to the server's
// core/text.ts types and to vscode-languageserver's, so values flow through
// without conversion.
//
// This file is FROZEN for the build agents: if something is missing, extend
// it in a backwards compatible way (new optional fields / new message types)
// and mention it in the final report.

// ============================================================= geometry

export interface Position {
  /** Zero-based line. */
  line: number;
  /** Zero-based UTF-16 code unit offset within the line. */
  character: number;
}

/** Half-open range [start, end). */
export interface Range {
  start: Position;
  end: Position;
}

// ============================================================= value targets (LSP)

/** Custom LSP request: client -> server. Params `ValueTargetsParams`, result `ValueTargetsResult`. */
export const VALUE_TARGETS_REQUEST = 'glslLsp/valueTargets';

/**
 * What a widget edits.
 *  - `float`   a single number literal (optionally with unary minus).
 *  - `vec2`    `vec2(x, y)` constructor (or `#iUniform vec2`).
 *  - `vec3`    `vec3(...)` / `color3(...)`; `colorish` decides color vs direction widget.
 *  - `vec4`    `vec4(...)` / `color4(...)`.
 *  - `palette` iq cosine palette: `children` are exactly 4 vec3 targets a, b, c, d.
 *  - `multi`   a statement/line with several value targets: `children` holds them (1 level deep).
 */
export type ValueKind = 'float' | 'vec2' | 'vec3' | 'vec4' | 'palette' | 'multi';

/** One scalar slot of a target. For `float` there is exactly one. */
export interface ValueComponent {
  /**
   * Range of the literal text, INCLUDING a unary minus that belongs to it
   * (`vec2(-0.5, 1.0)` -> `-0.5`). A binary minus (`x - 0.5`) is not included.
   * For a non-editable component this is the range of the argument expression.
   */
  range: Range;
  /** Current numeric value (NaN when `editable` is false and the value is unknown). */
  value: number;
  /** Source text of `range` exactly as in the document (used to verify before editing). */
  text: string;
  /**
   * False when the argument is not a plain number literal (`vec3(t, 0.5, 1.0)`:
   * component 0 is `t`). The widget shows it locked; edits never touch it.
   */
  editable: boolean;
  /** True for an integer literal (`3`, no '.', no exponent): formatted without '.', step >= 1. */
  integer?: boolean;
}

/** Shader-toy `#iUniform` metadata, parsed to numbers where possible. */
export interface UniformInfo {
  /** Declared shader-toy type: `float`, `vec2`, `vec3`, `color3`, `color4`, ... */
  declaredType: string;
  /** `in { min, max }` lower bound (same for every component). */
  min?: number;
  /** `in { min, max }` upper bound. */
  max?: number;
  /** `step 0.1` */
  step?: number;
}

/** Where the target came from; drives the label and pin anchoring. */
export type DeclKind =
  | 'iUniform' // #iUniform float u_speed = 1.0 in {0, 4}
  | 'const' // const float K = 2.0; (global or local)
  | 'global' // non-const global with an initializer
  | 'local' // local variable initializer: float r = 0.25;
  | 'define' // #define SPEED 1.5
  | 'assignment' // col = vec3(...);  (name = assignment target)
  | 'argument' // literal passed to a call: smoothstep(0.1, 0.2, d) (name = parameter or callee)
  | 'expression'; // anything else

export interface ValueTarget {
  /**
   * Identifier unique within one response, stable while the document is not
   * edited above the target: `${kind}:${range.start.line}:${range.start.character}`.
   * Not suitable for persistence (use `anchor`).
   */
  id: string;
  kind: ValueKind;
  /** Document the ranges refer to. May differ from the request uri (cursor on a uniform declared elsewhere). */
  uri: string;
  /** Document version the ranges were computed against (null when read from disk). */
  version: number | null;
  /**
   * Declared name when there is one: variable/uniform/define name, assignment
   * target (`col`, `fragColor.rgb` -> `fragColor`), or the parameter name for a call
   * argument when known (`edge0`).
   */
  name?: string;
  /** How `name` was obtained. */
  declKind: DeclKind;
  /** Enclosing function name, when inside one. */
  functionName?: string;
  /** Short source snippet for labels: the target text, whitespace-collapsed, <= 48 chars with '…'. */
  snippet: string;
  /** Anchor to persist when pinning this target (fresh, matches the current text). */
  anchor: PinAnchor;
  /** Whole literal or constructor: `0.25`, `vec3(1.0, 0.5, 0.2)`, `palette(t, ...)` call, statement for `multi`. */
  range: Range;
  /**
   * Constructor name as written for vector kinds (`vec3`, `color3`, ...);
   * undefined for float/palette/multi. Used when rewriting a splat.
   */
  ctor?: string;
  /**
   * Single-argument vector constructor (`vec3(0.5)`): components has length 1.
   * The client expands it to N arguments when the components become unequal.
   */
  splat?: boolean;
  /**
   * Scalar slots in order. float: 1; vecN: N (1 when splat); palette/multi: [] (see children).
   */
  components: ValueComponent[];
  /** Server heuristic (features/colors.ts): this vec3/vec4 looks like a color. */
  colorish: boolean;
  /** Present when the value is a shader-toy `#iUniform` default. */
  uniform?: UniformInfo;
  /** palette: [a, b, c, d] (vec3 each); multi: the value targets of the statement in source order. */
  children?: ValueTarget[];
  /** multi: index of the child under/nearest the cursor (cursor requests only). */
  activeChild?: number;
  /**
   * palette only: which call/expression shape matched, for the label.
   *  - `call`: palette(t, a, b, c, d) or any call with 4 trailing vec3 literal args.
   *  - `expression`: a + b * cos(6.28318 * (c * t + d)).
   */
  paletteShape?: 'call' | 'expression';
  /**
   * Not written in the source, value known: the `c` of an iq palette written
   * without it (`a + b * cos(6.28318 * (t + d))`, c = vec3(1.0)). Its
   * components are read-only (`editable: false`) but `value` is meaningful.
   */
  implicit?: boolean;
}

/**
 * Persistent, edit-tolerant reference to a value target. Created by the
 * server (ValueTarget.anchor) and stored by the client in workspaceState.
 * Resolution order on the server (docs/VALUES.md "Pin anchoring"):
 *   1. declaration: `declName` (+ `declKind`, + `functionName` for locals),
 *   2. fingerprint: a line whose `fingerprint` matches exactly, nearest to `line`,
 *   3. fuzzy: best similarity >= 0.75 within +/- 200 lines of `line`,
 *   4. none -> stale.
 * Then `ordinal` picks the n-th target of that kind on the found line/initializer,
 * and `childIndex` the child of a multi/palette.
 */
export interface PinAnchor {
  /** Document uri (as the client sees it: `TextDocument.uri.toString()`). */
  uri: string;
  kind: ValueKind;
  declName?: string;
  declKind?: DeclKind;
  /** Enclosing function, for locals (two functions may both declare `col`). */
  functionName?: string;
  /** Line text with every number literal replaced by `#` and whitespace collapsed: `vec3 col = vec3(#, #, #);` */
  fingerprint: string;
  /** Last known zero-based line (updated on every successful resolution). */
  line: number;
  /** Last known character of `range.start` in that line. */
  character: number;
  /** n-th target (0-based, same kind) on the line, counted from the left. */
  ordinal: number;
  /**
   * Source text of the target when the anchor was made (`0.8`, `vec3(0.9, 0.8, 0.2)`).
   * Disambiguates lines with the same fingerprint (LUT entries, repeated statements).
   */
  text?: string;
  /** Fingerprints of the previous / next non-blank lines (context for fingerprint matches). */
  prevFingerprint?: string;
  nextFingerprint?: string;
  /**
   * Set by the client when an edit removed or replaced the pinned line as a
   * whole: a line match then needs the same `text` (a neighbour sliding into
   * the deleted line's place is not the pin). Cleared by the next resolution.
   */
  strict?: boolean;
}

export interface ValueTargetsParams {
  /** Document to look in. Anchors in `anchors` must all have this uri. */
  uri: string;
  /** Cursor mode: find the value under / nearest to this position. */
  position?: Position;
  /** Pin mode: resolve these anchors. Both modes may be combined in one request. */
  anchors?: PinAnchor[];
}

/** How a pin anchor was found again. */
export type AnchorMatch = 'declaration' | 'fingerprint' | 'fuzzy' | 'none';

export interface AnchorResolution {
  /** Found target, or null -> the pin is stale (target missing). */
  target: ValueTarget | null;
  /** Refreshed anchor to store (line/character/fingerprint updated); the input anchor when not found. */
  anchor: PinAnchor;
  match: AnchorMatch;
}

export interface ValueTargetsResult {
  uri: string;
  /** Version of the document the result was computed for (null: not open). */
  version: number | null;
  /** Present when `position` was given: best target at the cursor, or null. */
  cursor?: ValueTarget | null;
  /** Present when `anchors` was given: same length and order as the request's anchors. */
  anchors?: AnchorResolution[];
}

// ============================================================= rows (extension -> webview view model)

/** The always-present first row. */
export const CURSOR_ROW_ID = 'cursor';

export type RowStatus =
  | 'ok' // target present
  | 'empty' // cursor row: nothing editable at the cursor
  | 'noEditor' // cursor row: no GLSL editor open
  | 'loading' // first resolution pending
  | 'stale'; // pinned: target disappeared (anchor match 'none') or file missing

/** Per-row widget preferences, persisted with the pin (cursor row: in memory, keyed by anchor). */
export interface RowOptions {
  /** vec3/vec4 widget mode override; undefined -> follow `target.colorish`. */
  mode?: 'color' | 'vector';
  /** float/vec2 range override set by the user (editable min/max). */
  range?: { min: number; max: number };
  /** vec3 direction widget: keep the vector length while rotating (default true). */
  keepLength?: boolean;
  /** multi/palette: expanded state of the sub-rows in the list (default true for the selected row). */
  expanded?: boolean;
}

export interface RowState {
  /** CURSOR_ROW_ID or the pin id. */
  id: string;
  kind: 'cursor' | 'pin';
  status: RowStatus;
  /** Present when status === 'ok'. */
  target?: ValueTarget;
  /** Display label: name, else snippet; for stale pins the last known label. */
  label: string;
  /** Base name of the target's file (`noise.glsl`). */
  fileName?: string;
  /** Whether the target lives in the active GLSL editor's document (fileName is shown when false). */
  inActiveFile: boolean;
  /** 1-based line for display (`:42`). */
  line?: number;
  options: RowOptions;
  /** Cursor row only: id of the pin that already points at this target (pin button shows "pinned"). */
  pinnedAs?: string;
}

/** Identifies what a widget/edit addresses: a row, optionally a child of its multi/palette target. */
export interface TargetRef {
  rowId: string;
  /** Index into `target.children` (multi / palette). Omitted for the row's own target. */
  childIndex?: number;
}

export interface ValuesSettings {
  /** Minimum ms between edit-updates sent by the webview (glslLsp.values.throttleMs). */
  throttleMs: number;
  /** Maximum decimals written to the document (glslLsp.values.maxDecimals). */
  maxDecimals: number;
}

// ============================================================= messages: extension -> webview

/** Full view model. Sent on ready, on every cursor/pin/document change (coalesced ~16 ms). */
export interface StateMessage {
  type: 'state';
  /** rows[0] is always the cursor row; pins follow in pin order. */
  rows: RowState[];
  selection: TargetRef;
  settings: ValuesSettings;
  /** Base name of the active GLSL document, if any (header subtitle). */
  activeFileName?: string;
}

/** Reply to editBegin when the gesture cannot start or to editUpdate when it had to stop. */
export interface EditRejectedMessage {
  type: 'editRejected';
  gestureId: number;
  /** Human readable, shown as a transient notice in the widget footer. */
  reason: string;
}

/** Ask the webview to move keyboard focus to the selected widget (command glslLsp.focusValues). */
export interface FocusWidgetMessage {
  type: 'focusWidget';
}

/** Transient notice (e.g. "Pinned u_speed", "Value no longer found"). */
export interface NoticeMessage {
  type: 'notice';
  text: string;
  severity: 'info' | 'warning';
}

export type ExtensionToWebview = StateMessage | EditRejectedMessage | FocusWidgetMessage | NoticeMessage;

// ============================================================= messages: webview -> extension

/** Webview loaded and listening; the extension answers with a StateMessage. */
export interface ReadyMessage {
  type: 'ready';
}

/** User selected a row (or a sub-row). Selecting the cursor row = "back to cursor". */
export interface SelectMessage {
  type: 'select';
  ref: TargetRef;
}

/** Pin the target of `ref` (normally the cursor row, or one of its children). */
export interface PinMessage {
  type: 'pin';
  ref: TargetRef;
}

export interface UnpinMessage {
  type: 'unpin';
  pinId: string;
}

/** Drag-reorder of pins: the full new order of pin ids. */
export interface ReorderPinsMessage {
  type: 'reorderPins';
  pinIds: string[];
}

/** Reveal the target in its editor (double click / Enter on a row / "Go to" button). */
export interface RevealMessage {
  type: 'reveal';
  ref: TargetRef;
}

/** Persist widget preferences for a row (mode toggle, range edit, keepLength, expanded). Merged. */
export interface SetRowOptionsMessage {
  type: 'setRowOptions';
  rowId: string;
  options: RowOptions;
  /**
   * Option keys to reset to their default. Needed because `undefined` fields
   * vanish when the message is serialised (`{ range: undefined }` arrives as `{}`).
   */
  clear?: (keyof RowOptions)[];
}

/**
 * Start of an edit gesture (pointer down on a widget, list scrub start, first
 * key repeat). The extension snapshots the target and opens an undo group.
 * `gestureId` is chosen by the webview, increasing.
 */
export interface EditBeginMessage {
  type: 'editBegin';
  gestureId: number;
  ref: TargetRef;
}

/**
 * New values during a gesture (throttled by the webview to settings.throttleMs;
 * the extension additionally drops intermediate updates while an edit is in flight).
 * `values` is aligned with the addressed target's `components`
 * (null = leave that component unchanged). For a splat vec, a length-N array
 * is allowed: the extension expands the constructor when they differ.
 * For a palette/multi target addressed WITHOUT childIndex (palette preset,
 * "reset all"), `values` is the concatenation of every child's components
 * in child order (palette: 12 numbers a.rgb, b.rgb, c.rgb, d.rgb).
 */
export interface EditUpdateMessage {
  type: 'editUpdate';
  gestureId: number;
  values: (number | null)[];
  /** Decimals to write (from the widget step); the extension clamps to settings.maxDecimals. */
  decimals: number;
}

/** End of the gesture. commit=false (Escape) restores the text captured at editBegin. */
export interface EditEndMessage {
  type: 'editEnd';
  gestureId: number;
  commit: boolean;
}

/**
 * One-shot edit = begin + update + end in one undo step (typing in a numeric
 * input, hex field, a single arrow key press).
 */
export interface EditOnceMessage {
  /** Same `values` layout rules as EditUpdateMessage. */
  type: 'editOnce';
  ref: TargetRef;
  values: (number | null)[];
  decimals: number;
}

export type WebviewToExtension =
  | ReadyMessage
  | SelectMessage
  | PinMessage
  | UnpinMessage
  | ReorderPinsMessage
  | RevealMessage
  | SetRowOptionsMessage
  | EditBeginMessage
  | EditUpdateMessage
  | EditEndMessage
  | EditOnceMessage;

// ============================================================= persistence (client only, but documented here)

/** One pin as stored in workspaceState under PINS_STATE_KEY (array, in display order). */
export interface StoredPin {
  /** Random id (`p_` + 8 base36 chars). */
  id: string;
  anchor: PinAnchor;
  /** Last label seen, shown while stale. */
  label: string;
  /** Child of a multi/palette that was pinned (pin points at that child only when set). */
  childIndex?: number;
  /**
   * Identity of the pinned child, so it is found again when literals are
   * inserted before it (childIndex alone would retarget). Absent in old pins.
   */
  child?: ChildKey;
  options: RowOptions;
  /** ms since epoch. */
  createdAt: number;
}

export const PINS_STATE_KEY = 'glslLsp.values.pins.v1';

/** What identifies a pinned child of a multi/palette besides its index. */
export interface ChildKey {
  kind: ValueKind;
  /** `kind:` + the component texts (`float:0.3`, `vec3:1.0,0.5,0.2`). */
  sig: string;
  name?: string;
  /** Index counted from the end of the children. */
  fromEnd: number;
  /** Number of children when last resolved. */
  total: number;
}

// ============================================================= helpers

/** Number of scalar components a vector kind writes (float 1). 0 for palette/multi. */
export function componentCount(kind: ValueKind): number {
  switch (kind) {
    case 'float':
      return 1;
    case 'vec2':
      return 2;
    case 'vec3':
      return 3;
    case 'vec4':
      return 4;
    default:
      return 0;
  }
}

/** Resolves a TargetRef against a row's target (child when childIndex is set). */
export function targetOf(row: RowState | undefined, childIndex?: number): ValueTarget | undefined {
  const t = row?.target;
  if (!t) return undefined;
  if (childIndex === undefined) return t;
  return t.children?.[childIndex];
}

export function isWebviewMessage(m: unknown): m is WebviewToExtension {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}
