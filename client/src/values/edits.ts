// EditApplier: applies widget values to documents live.
//
// One gesture = one undo step (visible editors: undo stops via TextEditor.edit;
// hidden documents: WorkspaceEdit, best effort). The gesture owns a span of the
// document; each update rewrites the whole span from the begin-time snapshot
// (see editText.ts), so cancel/restore is exact and only the span length needs
// tracking. User typing is never clobbered: a user edit that touches the span
// aborts the gesture, edits before it just shift the span.
//
// Several gestures may be alive on one document (a key gesture on one slider
// while another is dragged). Writes to one document are serialised and every
// change is attributed to the gesture that made it: the other gestures shift
// (or abort when it overlaps them) exactly as for a user edit.

import { Position, Range, Uri, WorkspaceEdit, window, workspace, type Disposable, type TextDocument, type TextEditor } from 'vscode';
import { buildGroups, buildReplacement, classifyChange, slotIntact, spanOf, type GroupSpec, type TargetLike } from './editText';

export interface EditContext {
  maxDecimals: () => number;
}

interface Gesture {
  id: number;
  uri: string;
  doc: TextDocument;
  spanStart: number;
  spanLen: number;
  snapshot: string;
  charBefore: string;
  groups: GroupSpec[];
  /** Text currently in the document for the span. */
  lastText: string;
  pending?: { values: (number | null)[]; decimals: number };
  inFlight?: Promise<void>;
  appliedAny: boolean;
  dead: boolean;
}

const RECENT_TYPING_MS = 400;

export class EditApplier implements Disposable {
  private readonly gestures = new Map<number, Gesture>();
  /** Gesture whose write is being applied to a document (attributes the change event). */
  private readonly selfEditing = new Map<string, Gesture>();
  /** Per-document write chain: one applier edit at a time per document. */
  private readonly writeChains = new Map<string, Promise<unknown>>();
  private readonly lastUserEdit = new Map<string, { time: number; start: number; end: number }>();
  private readonly sub: Disposable;

  /** Gesture aborted by the applier (user typed in the span, document closed, ...). */
  onAborted: (gestureId: number, reason: string) => void = () => {};
  /** Something was written to `uri` (gesture end / one-shot); the controller re-queries then. */
  onDidEdit: (uri: string) => void = () => {};
  /** A gesture on `uri` ended (committed, cancelled, aborted or rejected), whether or not it wrote anything. */
  onDidEnd: (uri: string) => void = () => {};

  constructor(private readonly ctx: EditContext) {
    this.sub = workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e.document, e.contentChanges));
  }

  get active(): boolean {
    return this.gestures.size > 0;
  }

  activeUris(): Set<string> {
    return new Set([...this.gestures.values()].map((g) => g.uri));
  }

  /** Starts a gesture. Returns a rejection reason, or undefined on success. */
  async begin(gestureId: number, uri: string, target: TargetLike): Promise<string | undefined> {
    const prepared = await this.prepare(uri, target);
    if (typeof prepared === 'string') return prepared;
    const g: Gesture = { id: gestureId, uri, ...prepared, lastText: prepared.snapshot, appliedAny: false, dead: false };
    this.gestures.set(gestureId, g);
    return undefined;
  }

  update(gestureId: number, values: (number | null)[], decimals: number): void {
    const g = this.gestures.get(gestureId);
    if (!g || g.dead) return;
    g.pending = { values, decimals };
    void this.pump(g);
  }

  async end(gestureId: number, commit: boolean): Promise<void> {
    const g = this.gestures.get(gestureId);
    if (!g) return;
    try {
      // Let an in-flight apply finish; then flush the latest values.
      while (g.inFlight) await g.inFlight;
      if (g.dead) return;
      if (commit && g.pending) await this.pumpOnce(g);
      if (g.dead) return;
      const finalText = g.lastText;
      if (g.appliedAny) {
        const visible = this.visibleEditor(g.uri);
        if (commit) {
          if (visible) {
            // Restore + rewrite so the whole gesture is a single undo element.
            if (finalText !== g.snapshot) {
              await this.replaceSpan(g, g.snapshot, { before: false, after: false });
              await this.replaceSpan(g, finalText, { before: false, after: true });
            }
          }
        } else if (finalText !== g.snapshot) {
          await this.replaceSpan(g, g.snapshot, { before: false, after: true });
        }
      }
    } finally {
      const wasDead = g.dead && !this.gestures.has(gestureId);
      g.dead = true;
      this.gestures.delete(gestureId);
      if (!wasDead) {
        if (g.appliedAny) this.onDidEdit(g.uri);
        this.onDidEnd(g.uri);
      }
    }
  }

  /**
   * Ends every live gesture (the webview that owned them is gone or was
   * re-created). What was written stays and closes its undo group.
   */
  async endAll(): Promise<void> {
    await Promise.all([...this.gestures.keys()].map((id) => this.end(id, true)));
  }

  /** begin + update + end in one undo step. Returns a rejection reason or undefined. */
  async once(uri: string, target: TargetLike, values: (number | null)[], decimals: number): Promise<string | undefined> {
    const prepared = await this.prepare(uri, target);
    if (typeof prepared === 'string') return prepared;
    const g: Gesture = { id: -1, uri, ...prepared, lastText: prepared.snapshot, appliedAny: false, dead: false };
    const text = this.newText(g, values, decimals);
    if (text === g.snapshot) return undefined;
    g.pending = undefined;
    const ok = await this.replaceSpan(g, text, { before: true, after: true });
    if (!ok) return 'The edit could not be applied';
    this.onDidEdit(uri);
    this.onDidEnd(uri);
    return undefined;
  }

  dispose(): void {
    this.sub.dispose();
    this.gestures.clear();
  }

  // ------------------------------------------------------------------ internals

  private async prepare(
    uri: string,
    target: TargetLike,
  ): Promise<{ doc: TextDocument; spanStart: number; spanLen: number; snapshot: string; charBefore: string; groups: GroupSpec[] } | string> {
    let doc: TextDocument;
    try {
      doc = await workspace.openTextDocument(Uri.parse(uri));
    } catch {
      return 'The file could not be opened';
    }
    const offsetAt = (p: { line: number; character: number }) => doc.offsetAt(new Position(p.line, p.character));
    const groups = buildGroups(target, offsetAt);
    if (groups.every((g) => g.slots.every((s) => !s.editable))) return 'Nothing editable here';
    // The text of every editable component must still be what the server saw,
    // as a whole token (a stale `0.5` must not match the `0.5` prefix of `0.55`).
    const at = (o: number) => (o < 0 ? '' : doc.getText(new Range(doc.positionAt(o), doc.positionAt(o + 1))));
    for (const g of groups)
      for (const s of g.slots) {
        if (!s.editable) continue;
        const text = doc.getText(new Range(doc.positionAt(s.start), doc.positionAt(s.end)));
        if (!slotIntact(at(s.start - 1), text, at(s.end), s.text)) return 'The value changed in the editor';
      }
    const span = spanOf(target, groups, offsetAt);
    const typed = this.lastUserEdit.get(uri);
    if (typed && Date.now() - typed.time < RECENT_TYPING_MS && typed.start <= span.end && typed.end >= span.start) {
      return 'You are typing here';
    }
    const snapshot = doc.getText(new Range(doc.positionAt(span.start), doc.positionAt(span.end)));
    const charBefore = span.start > 0 ? doc.getText(new Range(doc.positionAt(span.start - 1), doc.positionAt(span.start))) : '';
    return { doc, spanStart: span.start, spanLen: span.end - span.start, snapshot, charBefore, groups };
  }

  private newText(g: Gesture, values: (number | null)[], decimals: number): string {
    return buildReplacement(g.snapshot, g.spanStart, g.groups, values, decimals, this.ctx.maxDecimals(), g.charBefore);
  }

  /** Coalescing apply loop: only the latest pending values are written once the previous edit resolved. */
  private pump(g: Gesture): Promise<void> {
    if (g.inFlight) return g.inFlight;
    const run = async () => {
      try {
        while (g.pending && !g.dead) await this.pumpOnce(g);
      } finally {
        g.inFlight = undefined;
      }
    };
    g.inFlight = run();
    return g.inFlight;
  }

  private async pumpOnce(g: Gesture): Promise<void> {
    const p = g.pending;
    g.pending = undefined;
    if (!p || g.dead) return;
    const text = this.newText(g, p.values, p.decimals);
    if (text === g.lastText) return;
    const first = !g.appliedAny;
    const ok = await this.replaceSpan(g, text, { before: first, after: false });
    if (!ok) this.abort(g, 'The edit could not be applied');
    else g.appliedAny = true;
  }

  private abort(g: Gesture, reason: string): void {
    if (g.dead) return;
    g.dead = true;
    g.pending = undefined;
    const owned = this.gestures.get(g.id) === g;
    if (owned) this.gestures.delete(g.id);
    if (g.id >= 0) this.onAborted(g.id, reason);
    if (g.appliedAny) this.onDidEdit(g.uri);
    if (owned) this.onDidEnd(g.uri);
  }

  private visibleEditor(uri: string): TextEditor | undefined {
    return window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
  }

  /** Replaces the span's current text. Updates the span length on success. Writes to one document are serialised. */
  private replaceSpan(g: Gesture, text: string, undo: { before: boolean; after: boolean }): Promise<boolean> {
    const prev = this.writeChains.get(g.uri) ?? Promise.resolve();
    const run = prev.then(() => this.replaceSpanNow(g, text, undo));
    const tail = run.catch(() => false);
    this.writeChains.set(g.uri, tail);
    void tail.then(() => {
      if (this.writeChains.get(g.uri) === tail) this.writeChains.delete(g.uri);
    });
    return run;
  }

  private async replaceSpanNow(g: Gesture, text: string, undo: { before: boolean; after: boolean }): Promise<boolean> {
    if (g.dead && g.id >= 0 && !this.gestures.has(g.id) && !g.appliedAny) return false;
    // Offsets are read now: earlier writes may have shifted this gesture.
    const range = new Range(g.doc.positionAt(g.spanStart), g.doc.positionAt(g.spanStart + g.spanLen));
    this.selfEditing.set(g.uri, g);
    try {
      const editor = this.visibleEditor(g.uri);
      let ok: boolean;
      if (editor) {
        ok = await editor.edit((b) => b.replace(range, text), { undoStopBefore: undo.before, undoStopAfter: undo.after });
      } else {
        const we = new WorkspaceEdit();
        we.replace(g.doc.uri, range, text);
        ok = await workspace.applyEdit(we);
      }
      if (ok) {
        g.spanLen = text.length;
        g.lastText = text;
      }
      return ok;
    } catch {
      return false;
    } finally {
      if (this.selfEditing.get(g.uri) === g) this.selfEditing.delete(g.uri);
    }
  }

  private onDocumentChanged(doc: TextDocument, changes: readonly { range: Range; rangeOffset: number; rangeLength: number; text: string }[]): void {
    const uri = doc.uri.toString();
    const self = this.selfEditing.get(uri);
    if (!self) {
      for (const c of changes) {
        this.lastUserEdit.set(uri, { time: Date.now(), start: c.rangeOffset, end: c.rangeOffset + c.text.length });
      }
    }
    for (const g of [...this.gestures.values()]) {
      // The writing gesture tracks its own span; every other gesture on the document shifts or aborts.
      if (g.uri !== uri || g.dead || g === self) continue;
      // Change offsets of one event are relative to the pre-change document: classify all against the unshifted span.
      let shift = 0;
      let hit = false;
      for (const c of changes) {
        const k = classifyChange(g.spanStart, g.spanLen, c.rangeOffset, c.rangeLength, c.text.length);
        if (k.kind === 'intersect') hit = true;
        else if (k.kind === 'before') shift += k.shift;
      }
      if (hit) this.abort(g, 'Edited in the editor');
      else if (shift) this.shiftGesture(g, shift);
    }
  }

  private shiftGesture(g: Gesture, shift: number): void {
    g.spanStart += shift;
    for (const grp of g.groups)
      for (const s of grp.slots) {
        s.start += shift;
        s.end += shift;
      }
  }
}
