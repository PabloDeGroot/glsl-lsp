// ValuesController: owns the view model of the Values panel.
//
//   cursor tracking  -> glslLsp/valueTargets (position)  -> cursor row
//   pins (workspace) -> glslLsp/valueTargets (anchors)   -> pinned rows
//   webview messages -> selection / pins / options / edits (EditApplier)
//   everything       -> one coalesced StateMessage per animation frame (~16 ms)
//
// See docs/VALUES.md sections 6 and 7.

import { Uri, commands, window, workspace, Range, Selection, type Disposable, type ExtensionContext, type TextDocumentContentChangeEvent } from 'vscode';
import { MAX_DECIMALS } from '../../../shared/valuesMath';
import {
  CURSOR_ROW_ID,
  targetOf,
  type ExtensionToWebview,
  type RowOptions,
  type RowState,
  type RowStatus,
  type StateMessage,
  type StoredPin,
  type TargetRef,
  type ValueTarget,
  type ValueTargetsParams,
  type ValueTargetsResult,
  type ValuesSettings,
  type WebviewToExtension,
} from '../../../shared/valuesProtocol';
import { CursorTracker } from './cursor';
import { EditApplier } from './edits';
import { anchorKey, childKeyOf, mergeOptions, pickChild, PinStore } from './pins';
import { baseName, labelFor, sameTargetLocation } from './rows';

export interface ControllerHost {
  request(params: ValueTargetsParams): Promise<ValueTargetsResult | undefined>;
  post(message: ExtensionToWebview): void;
  /** True when the view exists and is visible. */
  visible(): boolean;
  /** Reveal the view without taking focus; false when it was never opened. */
  reveal(): boolean;
}

interface CursorState {
  status: RowStatus;
  target?: ValueTarget;
  label: string;
}

interface PinResolution {
  target: ValueTarget | null;
  loaded: boolean;
  /** Parent of a child pin (for the label). */
  parent?: ValueTarget;
}

const PUSH_DELAY_MS = 16;
const DOC_DEBOUNCE_MS = 150;

export class ValuesController implements Disposable {
  private readonly tracker = new CursorTracker(60);
  private readonly store: PinStore;
  private readonly applier: EditApplier;
  private readonly disposables: Disposable[] = [];

  private cursor: CursorState = { status: 'noEditor', label: '' };
  private readonly resolved = new Map<string, PinResolution>();
  private readonly cursorOptions = new Map<string, RowOptions>();
  private selection: TargetRef = { rowId: CURSOR_ROW_ID };

  private cursorSeq = 0;
  private readonly pinSeq = new Map<string, number>();
  private readonly docTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deferred = new Set<string>();
  private dirty = true;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private editQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    context: ExtensionContext,
    private readonly host: ControllerHost,
  ) {
    this.store = new PinStore(context.workspaceState);
    this.applier = new EditApplier({ maxDecimals: () => this.settings().maxDecimals });
    this.applier.onAborted = (gestureId, reason) => {
      this.host.post({ type: 'editRejected', gestureId, reason });
    };
    this.applier.onDidEdit = (uri) => {
      this.deferred.delete(uri);
      void this.runQuery(uri, uri === this.tracker.uri, true);
    };
    // A gesture that wrote nothing still has to release the queries deferred while it ran.
    this.applier.onDidEnd = (uri) => {
      if (!this.deferred.has(uri) || this.applier.activeUris().has(uri)) return;
      this.deferred.delete(uri);
      void this.runQuery(uri, uri === this.tracker.uri, true);
    };
    for (const p of this.store.list()) this.resolved.set(p.id, { target: null, loaded: false });
    this.cursor = this.tracker.editor ? { status: 'loading', label: '' } : { status: 'noEditor', label: '' };
    this.updateContext();

    this.disposables.push(
      this.tracker,
      this.applier,
      this.tracker.onDidChange((kind) => this.onCursorChange(kind)),
      workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e.document.uri.toString(), e.document.languageId, e.contentChanges)),
      workspace.onDidOpenTextDocument((d) => {
        const uri = d.uri.toString();
        if (this.store.list().some((p) => p.anchor.uri === uri)) this.scheduleDoc(uri);
      }),
      workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('glslLsp.values')) this.schedulePush();
      }),
    );
  }

  // ------------------------------------------------------------------ public API

  settings(): ValuesSettings {
    const c = workspace.getConfiguration('glslLsp.values');
    return {
      throttleMs: Math.max(0, Number(c.get('throttleMs', 33))),
      maxDecimals: Math.max(1, Math.min(6, Number(c.get('maxDecimals', 4)))),
    };
  }

  /** Re-resolve everything (server restart, view shown). */
  refreshAll(): void {
    if (this.disposed) return;
    this.dirty = false;
    const active = this.tracker.uri;
    const uris = new Set<string>(this.store.list().map((p) => p.anchor.uri));
    if (active) uris.add(active);
    if (!active) {
      this.cursor = { status: 'noEditor', label: '' };
      this.schedulePush();
    }
    for (const uri of uris) void this.runQuery(uri, uri === active, true);
  }

  onVisibilityChange(visible: boolean): void {
    if (visible) {
      this.schedulePush(true);
      if (this.dirty) this.refreshAll();
    }
  }

  async pinAtCursor(): Promise<void> {
    const editor = this.tracker.editor;
    if (!editor) {
      window.setStatusBarMessage('GLSL: open a GLSL file to pin a value', 3000);
      return;
    }
    await this.runQuery(editor.document.uri.toString(), true, false, true);
    const t = this.cursor.target;
    if (!t) {
      window.setStatusBarMessage('GLSL: no value at the cursor', 3000);
      return;
    }
    const childIndex = t.kind === 'multi' && t.activeChild !== undefined && t.children?.[t.activeChild] ? t.activeChild : undefined;
    const shown = this.host.reveal();
    const result = this.pinCursor(childIndex);
    if (!shown && result) window.setStatusBarMessage(result.message, 3000);
  }

  clearPins(): void {
    this.store.clear();
    this.resolved.clear();
    this.selection = { rowId: CURSOR_ROW_ID };
    this.updateContext();
    this.schedulePush();
  }

  /** Called when the webview says it is ready (or was re-created). */
  onReady(): void {
    // Gestures of a previous webview instance can never end now: close them (keeps what they wrote).
    if (this.applier.active) void this.applier.endAll();
    this.schedulePush(true);
    this.refreshAll();
  }

  /** The view was disposed (reload, moved to another container): its gestures are orphaned. */
  onViewDisposed(): void {
    if (this.applier.active) void this.applier.endAll();
  }

  /** Nudge/edit helper: refresh the cursor row soon (after external edits). */
  nudgeDone(): void {
    const uri = this.tracker.uri;
    if (uri) this.scheduleDoc(uri);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    for (const t of this.docTimers.values()) clearTimeout(t);
    this.docTimers.clear();
    void this.store.flush();
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  // ------------------------------------------------------------------ webview messages

  handleMessage(m: WebviewToExtension): void {
    switch (m.type) {
      case 'ready':
        this.onReady();
        return;
      case 'select':
        if (this.rowById(m.ref.rowId)) {
          this.selection = { rowId: m.ref.rowId, ...(m.ref.childIndex !== undefined ? { childIndex: m.ref.childIndex } : {}) };
          this.schedulePush(true);
        }
        return;
      case 'pin': {
        if (m.ref.rowId !== CURSOR_ROW_ID) return;
        const r = this.pinCursor(m.ref.childIndex);
        if (r && !r.created) this.notice(r.message, 'info');
        return;
      }
      case 'unpin':
        this.unpin(m.pinId);
        return;
      case 'reorderPins':
        this.store.reorder(m.pinIds);
        this.schedulePush(true);
        return;
      case 'reveal':
        void this.reveal(m.ref);
        return;
      case 'setRowOptions':
        this.setOptions(m.rowId, withClears(m.options, m.clear));
        return;
      case 'editBegin':
      case 'editUpdate':
      case 'editEnd':
      case 'editOnce':
        this.editQueue = this.editQueue.then(() => this.handleEdit(m)).catch(() => undefined);
        return;
    }
  }

  private async handleEdit(m: Extract<WebviewToExtension, { type: 'editBegin' | 'editUpdate' | 'editEnd' | 'editOnce' }>): Promise<void> {
    const settings = this.settings();
    switch (m.type) {
      case 'editBegin': {
        const t = await this.freshTarget(m.ref);
        if (!t) {
          this.host.post({ type: 'editRejected', gestureId: m.gestureId, reason: 'This value is no longer available' });
          return;
        }
        const reason = await this.applier.begin(m.gestureId, t.uri, t);
        if (reason) this.host.post({ type: 'editRejected', gestureId: m.gestureId, reason });
        return;
      }
      case 'editUpdate':
        this.applier.update(m.gestureId, m.values, clampDecimals(m.decimals, settings.maxDecimals));
        return;
      case 'editEnd':
        await this.applier.end(m.gestureId, m.commit);
        return;
      case 'editOnce': {
        const t = await this.freshTarget(m.ref);
        if (!t) {
          this.host.post({ type: 'editRejected', gestureId: -1, reason: 'This value is no longer available' });
          return;
        }
        const reason = await this.applier.once(t.uri, t, m.values, clampDecimals(m.decimals, settings.maxDecimals));
        if (reason) this.host.post({ type: 'editRejected', gestureId: -1, reason });
        return;
      }
    }
  }

  /**
   * The target a new edit addresses, re-resolved when the document moved on
   * since it was computed (a gesture started right after another one ended,
   * before the follow-up query returned). Editing with stale offsets could
   * corrupt the literal; prepare() still verifies the text.
   */
  private async freshTarget(ref: TargetRef): Promise<ValueTarget | undefined> {
    let t = this.resolveRef(ref);
    for (let attempt = 0; t && attempt < 4; attempt++) {
      const doc = workspace.textDocuments.find((d) => d.uri.toString() === t!.uri);
      if (!doc || t.version === null || t.version === doc.version) return t;
      let r: ValueTargetsResult | undefined;
      try {
        r = await this.host.request({ uri: t.uri, anchors: [t.anchor] });
      } catch {
        r = undefined;
      }
      const res = r?.anchors?.[0];
      if (!r || !res) return t;
      if (r.version !== null && r.version !== doc.version) {
        await new Promise((ok) => setTimeout(ok, 25));
        continue;
      }
      if (!res.target) return undefined;
      t = res.target;
    }
    return t;
  }

  // ------------------------------------------------------------------ pins

  private pinCursor(childIndex?: number): { created: boolean; message: string } | undefined {
    const t = this.cursor.target;
    if (!t) return undefined;
    const target = childIndex !== undefined ? t.children?.[childIndex] : t;
    if (!target) return undefined;
    const label = labelFor(target, childIndex !== undefined ? t : undefined);
    for (const p of this.store.list()) {
      const r = this.resolved.get(p.id)?.target;
      if (r && p.childIndex === childIndex && sameTargetLocation(r, target)) return { created: false, message: `Already pinned: ${label}` };
    }
    const existing = this.store.findByAnchor(t.anchor, childIndex);
    if (existing) return { created: false, message: `Already pinned: ${label}` };
    const opts = this.cursorOptions.get(anchorKey(t.anchor)) ?? {};
    const childKey = childIndex !== undefined && t.children ? childKeyOf(t.children, childIndex) : undefined;
    const pin = this.store.add(t.anchor, label, opts, childIndex, Date.now(), childKey);
    this.resolved.set(pin.id, { target, loaded: true, parent: childIndex !== undefined ? t : undefined });
    this.updateContext();
    this.schedulePush(true);
    this.notice(`Pinned ${label}`, 'info');
    return { created: true, message: `Pinned ${label}` };
  }

  private unpin(id: string): void {
    if (!this.store.remove(id)) return;
    this.resolved.delete(id);
    if (this.selection.rowId === id) this.selection = { rowId: CURSOR_ROW_ID };
    this.updateContext();
    this.schedulePush(true);
  }

  private setOptions(rowId: string, options: RowOptions): void {
    if (rowId === CURSOR_ROW_ID) {
      const t = this.cursor.target;
      if (!t) return;
      const key = anchorKey(t.anchor);
      this.cursorOptions.set(key, mergeOptions(this.cursorOptions.get(key) ?? {}, options));
    } else {
      this.store.setOptions(rowId, options);
    }
    this.schedulePush(true);
  }

  private async reveal(ref: TargetRef): Promise<void> {
    const row = this.rowById(ref.rowId);
    if (!row) return;
    const t = targetOf(row, ref.childIndex);
    let uri: string | undefined;
    let range: Range | undefined;
    if (t) {
      uri = t.uri;
      range = new Range(t.range.start.line, t.range.start.character, t.range.end.line, t.range.end.character);
    } else {
      const pin = this.store.get(ref.rowId);
      if (pin) {
        uri = pin.anchor.uri;
        range = new Range(pin.anchor.line, pin.anchor.character, pin.anchor.line, pin.anchor.character);
      }
    }
    if (!uri || !range) return;
    try {
      const doc = await workspace.openTextDocument(Uri.parse(uri));
      const editor = await window.showTextDocument(doc, { preserveFocus: false });
      editor.selection = new Selection(range.start, range.end);
      editor.revealRange(range);
    } catch {
      this.notice('The file could not be opened', 'warning');
    }
  }

  // ------------------------------------------------------------------ resolving

  private resolveRef(ref: TargetRef): ValueTarget | undefined {
    const row = this.rowById(ref.rowId);
    return row ? targetOf(row, ref.childIndex) : undefined;
  }

  private rowById(id: string): RowState | undefined {
    return this.rows().find((r) => r.id === id);
  }

  // ------------------------------------------------------------------ queries

  private onCursorChange(kind: 'editor' | 'selection'): void {
    const editor = this.tracker.editor;
    if (kind === 'editor') {
      if (!editor) {
        this.cursor = { status: 'noEditor', label: '' };
        this.schedulePush();
        return;
      }
      this.cursor = { ...this.cursor, status: this.cursor.target ? this.cursor.status : 'loading' };
      this.schedulePush();
      void this.runQuery(editor.document.uri.toString(), true, true);
      return;
    }
    if (!editor || !workspace.getConfiguration('glslLsp.values').get('followCursor', true)) return;
    void this.runQuery(editor.document.uri.toString(), true, false);
  }

  private onDocumentChange(uri: string, languageId: string, changes: readonly TextDocumentContentChangeEvent[]): void {
    if (changes.length === 0) return;
    const hasPins = this.store.list().some((p) => p.anchor.uri === uri);
    // Keep pin lines on their targets between resolutions (edits above a pin).
    if (hasPins) this.store.shiftLines(uri, changes);
    if (languageId !== 'glsl' && !hasPins) return;
    this.scheduleDoc(uri);
  }

  private scheduleDoc(uri: string): void {
    const prev = this.docTimers.get(uri);
    if (prev) clearTimeout(prev);
    this.docTimers.set(
      uri,
      setTimeout(() => {
        this.docTimers.delete(uri);
        void this.runQuery(uri, uri === this.tracker.uri, true);
      }, DOC_DEBOUNCE_MS),
    );
  }

  /**
   * One request per document: cursor position and/or the anchors of its pins.
   * Responses of superseded requests are dropped (sequence numbers).
   */
  private async runQuery(uri: string, wantCursor: boolean, wantPins: boolean, force = false): Promise<void> {
    if (this.disposed) return;
    if (!force && !this.host.visible()) {
      this.dirty = true;
      return;
    }
    if (this.applier.activeUris().has(uri)) {
      this.deferred.add(uri); // re-queried when the gesture ends
      return;
    }
    const editor = this.tracker.editor;
    const cursorHere = wantCursor && !!editor && editor.document.uri.toString() === uri;
    const pins = wantPins ? this.store.list().filter((p) => p.anchor.uri === uri) : [];
    if (!cursorHere && pins.length === 0) return;

    const params: ValueTargetsParams = { uri };
    let cSeq = 0;
    if (cursorHere && editor) {
      const a = editor.selection.active;
      params.position = { line: a.line, character: a.character };
      cSeq = ++this.cursorSeq;
    }
    const pSeq = pins.length ? (this.pinSeq.get(uri) ?? 0) + 1 : 0;
    if (pins.length) {
      this.pinSeq.set(uri, pSeq);
      params.anchors = pins.map((p) => p.anchor);
    }

    let result: ValueTargetsResult | undefined;
    try {
      result = await this.host.request(params);
    } catch {
      result = undefined;
    }
    if (this.disposed) return;

    const doc = workspace.textDocuments.find((d) => d.uri.toString() === uri);
    if (result && doc && result.version !== null && result.version !== doc.version) {
      this.scheduleDoc(uri); // the document moved on while the server worked
      return;
    }

    if (cSeq && cSeq === this.cursorSeq) {
      if (result) {
        const t = result.cursor ?? undefined;
        this.setCursorTarget(t);
      } else if (this.cursor.status === 'loading') {
        this.cursor = { status: 'empty', label: '' };
      }
    }
    if (pSeq && this.pinSeq.get(uri) === pSeq) {
      pins.forEach((pin, i) => {
        if (!this.store.get(pin.id)) return;
        const r = result?.anchors?.[i];
        if (!r) {
          if (!this.resolved.get(pin.id)?.loaded) this.resolved.set(pin.id, { target: null, loaded: true });
          return;
        }
        let target = r.target;
        let parent: ValueTarget | undefined;
        if (target && pin.childIndex !== undefined) {
          parent = target;
          const children = target.children ?? [];
          const i = pickChild(children, pin.childIndex, pin.child);
          target = i >= 0 ? children[i] : null;
          const key = i >= 0 ? childKeyOf(children, i) : undefined;
          if (key) this.store.refreshChild(pin.id, i, key);
        }
        this.resolved.set(pin.id, { target, loaded: true, parent });
        if (target) this.store.refresh(pin.id, r.anchor, labelFor(target, parent));
        else if (r.match !== 'none') this.store.refresh(pin.id, r.anchor);
      });
    }
    this.schedulePush();
  }

  private setCursorTarget(t: ValueTarget | undefined): void {
    const prev = this.cursor.target;
    if (!t) {
      this.cursor = { status: 'empty', label: '' };
    } else {
      this.cursor = { status: 'ok', target: t, label: labelFor(t) };
    }
    // Keep a child selection only while it is the same multi/palette.
    if (this.selection.rowId === CURSOR_ROW_ID && this.selection.childIndex !== undefined) {
      const sameTarget = !!t && !!prev && prev.id === t.id && prev.kind === t.kind;
      if (!sameTarget || !t?.children?.[this.selection.childIndex]) this.selection = { rowId: CURSOR_ROW_ID };
    }
  }

  // ------------------------------------------------------------------ state

  private rows(): RowState[] {
    const activeUri = this.tracker.uri;
    const c = this.cursor;
    const ct = c.status === 'ok' ? c.target : undefined;
    let pinnedAs: string | undefined;
    if (ct) {
      for (const p of this.store.list()) {
        const r = this.resolved.get(p.id)?.target;
        if (r && p.childIndex === undefined && sameTargetLocation(r, ct)) {
          pinnedAs = p.id;
          break;
        }
      }
    }
    const cursorRow: RowState = {
      id: CURSOR_ROW_ID,
      kind: 'cursor',
      status: c.status,
      label: c.label,
      inActiveFile: !ct || ct.uri === activeUri,
      options: ct ? (this.cursorOptions.get(anchorKey(ct.anchor)) ?? {}) : {},
    };
    if (ct) {
      cursorRow.target = ct;
      cursorRow.fileName = baseName(ct.uri);
      cursorRow.line = ct.range.start.line + 1;
    } else if (activeUri) {
      cursorRow.fileName = baseName(activeUri);
    }
    if (pinnedAs) cursorRow.pinnedAs = pinnedAs;

    const rows: RowState[] = [cursorRow];
    for (const p of this.store.list()) rows.push(this.pinRow(p, activeUri));
    return rows;
  }

  private pinRow(p: StoredPin, activeUri: string | undefined): RowState {
    const res = this.resolved.get(p.id);
    const t = res?.target ?? undefined;
    const status: RowStatus = !res || !res.loaded ? 'loading' : t ? 'ok' : 'stale';
    const row: RowState = {
      id: p.id,
      kind: 'pin',
      status,
      label: t ? labelFor(t, res?.parent) : p.label,
      fileName: baseName(t?.uri ?? p.anchor.uri),
      inActiveFile: (t?.uri ?? p.anchor.uri) === activeUri,
      line: (t ? t.range.start.line : p.anchor.line) + 1,
      options: p.options,
    };
    if (t) row.target = t;
    return row;
  }

  buildState(): StateMessage {
    const rows = this.rows();
    let selection = this.selection;
    const row = rows.find((r) => r.id === selection.rowId);
    if (!row) selection = { rowId: CURSOR_ROW_ID };
    else if (selection.childIndex !== undefined && !row.target?.children?.[selection.childIndex]) selection = { rowId: row.id };
    this.selection = selection;
    const state: StateMessage = { type: 'state', rows, selection, settings: this.settings() };
    const active = this.tracker.uri;
    if (active) state.activeFileName = baseName(active);
    return state;
  }

  private schedulePush(immediate = false): void {
    if (this.disposed) return;
    if (this.pushTimer) {
      if (!immediate) return;
      clearTimeout(this.pushTimer);
    }
    this.pushTimer = setTimeout(
      () => {
        this.pushTimer = undefined;
        if (!this.disposed) this.host.post(this.buildState());
      },
      immediate ? 0 : PUSH_DELAY_MS,
    );
  }

  private notice(text: string, severity: 'info' | 'warning'): void {
    this.host.post({ type: 'notice', text, severity });
  }

  private updateContext(): void {
    void commands.executeCommand('setContext', 'glslLsp.values.hasPins', this.store.size > 0);
  }

  /** Used by index.ts for glslLsp.focusValues. */
  focusWidget(): void {
    this.host.post({ type: 'focusWidget' });
  }
}

/** Turns the `clear` keys of a setRowOptions message back into explicit `undefined` patches (mergeOptions deletes them). */
export function withClears(options: RowOptions, clear: readonly (keyof RowOptions)[] | undefined): RowOptions {
  const out: RowOptions = { ...(options ?? {}) };
  for (const k of clear ?? []) if (typeof k === 'string') (out as Record<string, unknown>)[k] = undefined;
  return out;
}

/**
 * Decimals requested by the webview, sanitised. glslLsp.values.maxDecimals is
 * applied per literal when formatting (editText.fmt): a literal's own
 * precision may exceed it and tiny values switch to an exponent instead of
 * being rounded to 0.0, so the request itself is only bounded by MAX_DECIMALS.
 */
function clampDecimals(d: number, _max: number): number {
  const v = Number.isFinite(d) ? Math.round(d) : 2;
  return Math.max(1, Math.min(MAX_DECIMALS, v));
}
