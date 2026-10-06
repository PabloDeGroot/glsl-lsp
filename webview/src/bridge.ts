// Typed messaging to the extension plus edit-gesture helpers:
// begin/update/end with throttling (trailing flush), one-shot edits, and
// key-repeat gestures (presses within 600 ms form one undo step).

import type { TargetRef, WebviewToExtension } from '../../shared/valuesProtocol';
import { flatValues, refKey } from './math/targets';
import type { Store } from './store';

export type Post = (m: WebviewToExtension) => void;

export type Values = (number | null)[];

const KEY_GESTURE_MS = 600;

export class Gesture {
  alive = true;
  private pending: { values: Values; decimals: number } | null = null;
  private lastSent = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last: { values: Values; decimals: number } | null = null;

  constructor(
    readonly id: number,
    readonly ref: TargetRef,
    private readonly bridge: Bridge,
    /** Values when the gesture started (restored optimistically on cancel). */
    readonly original: Values,
  ) {}

  update(values: Values, decimals: number): void {
    if (!this.alive) return;
    this.last = { values: [...values], decimals };
    this.bridge.store.setOverride(this.ref, values, decimals, true);
    this.pending = this.last;
    const wait = this.bridge.store.settings.throttleMs - (Date.now() - this.lastSent);
    if (wait <= 0) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending || !this.alive) return;
    this.bridge.post({ type: 'editUpdate', gestureId: this.id, values: this.pending.values, decimals: this.pending.decimals });
    this.pending = null;
    this.lastSent = Date.now();
  }

  end(commit: boolean): void {
    if (!this.alive) return;
    if (commit) this.flush();
    else {
      if (this.timer) clearTimeout(this.timer);
      this.pending = null;
    }
    this.alive = false;
    this.bridge.post({ type: 'editEnd', gestureId: this.id, commit });
    this.bridge.finished(this);
    if (commit && this.last) this.bridge.store.settleOverride(this.ref);
    else if (!commit) {
      this.bridge.store.setOverride(this.ref, this.original, 6, false);
      this.bridge.store.settleOverride(this.ref);
    } else this.bridge.store.clearOverride(this.ref);
  }

  /** The extension rejected the gesture: stop silently (the caller shows the notice). */
  kill(): void {
    if (this.timer) clearTimeout(this.timer);
    this.alive = false;
    this.pending = null;
    this.bridge.store.clearOverride(this.ref);
  }
}

export class Bridge {
  /** Random base per webview instance: ids never collide with gestures of a previous (reloaded) instance. */
  private nextId = 1 + Math.floor(Math.random() * 1e6) * 1000;
  private gestures = new Map<number, Gesture>();
  private keyGestures = new Map<string, { g: Gesture; timer: ReturnType<typeof setTimeout> }>();
  /** Called when a gesture is rejected (for widgets to drop drag state). */
  onReject: ((g: Gesture) => void) | undefined;

  constructor(
    readonly post: Post,
    readonly store: Store,
  ) {}

  begin(ref: TargetRef): Gesture {
    // Any open key gesture ends first (same or another value): one live edit at a time keeps undo steps clean.
    this.endKeyGestures();
    const id = this.nextId++;
    const t = this.store.target(ref);
    const g = new Gesture(id, { ...ref }, this, t ? flatValues(t).map((v) => (Number.isFinite(v) ? v : null)) : []);
    this.gestures.set(id, g);
    this.post({ type: 'editBegin', gestureId: id, ref: { ...ref } });
    return g;
  }

  finished(g: Gesture): void {
    this.gestures.delete(g.id);
  }

  /** One-shot edit (typed value, hex, preset): one undo step. */
  once(ref: TargetRef, values: Values, decimals: number): void {
    this.endKeyGestures();
    this.store.setOverride(ref, values, decimals, false);
    this.post({ type: 'editOnce', ref: { ...ref }, values, decimals });
  }

  /** Keyboard edit: consecutive presses within 600 ms are one gesture / undo step. */
  key(ref: TargetRef, values: Values, decimals: number): void {
    const key = refKey(ref);
    let entry = this.keyGestures.get(key);
    if (!entry || !entry.g.alive) {
      const g = this.begin(ref); // ends other key gestures
      entry = { g, timer: setTimeout(() => {}, 0) };
      this.keyGestures.set(key, entry);
    }
    clearTimeout(entry.timer);
    entry.g.update(values, decimals);
    const g = entry.g;
    entry.timer = setTimeout(() => {
      this.keyGestures.delete(key);
      g.end(true);
    }, KEY_GESTURE_MS);
  }

  private endKeyGestures(): void {
    for (const [key, entry] of [...this.keyGestures]) {
      clearTimeout(entry.timer);
      this.keyGestures.delete(key);
      entry.g.end(true);
    }
  }

  /** editRejected from the extension. */
  reject(gestureId: number): void {
    const g = this.gestures.get(gestureId);
    if (!g) return;
    this.gestures.delete(gestureId);
    for (const [k, e] of this.keyGestures) if (e.g === g) this.keyGestures.delete(k);
    g.kill();
    this.onReject?.(g);
  }

  /** True when any gesture (drag or key) is running. */
  get busy(): boolean {
    return this.gestures.size > 0;
  }

  /** Cancels every running gesture (e.g. the selection changed under a drag). */
  cancelAll(): void {
    for (const g of [...this.gestures.values()]) g.end(false);
    for (const e of this.keyGestures.values()) clearTimeout(e.timer);
    this.keyGestures.clear();
  }
}

/**
 * Per-target edit helper used by widgets: maps drag phases to a gesture and
 * routes key/typed edits. `decimals` is the widget's current write precision.
 */
export class EditSession {
  private g: Gesture | null = null;
  /** start() was called; the gesture is opened lazily on the first move (a click alone edits nothing). */
  private armed = false;

  constructor(
    private readonly bridge: Bridge,
    public ref: TargetRef,
  ) {}

  get dragging(): boolean {
    return this.armed || !!this.g?.alive;
  }

  start(): boolean {
    if (this.g?.alive) this.g.end(true);
    this.g = null;
    this.armed = true;
    return true;
  }

  move(values: Values, decimals: number): void {
    if (this.armed) {
      this.armed = false;
      this.g = this.bridge.begin(this.ref);
    }
    if (!this.g?.alive) return;
    this.g.update(values, decimals);
  }

  end(commit = true): void {
    this.armed = false;
    if (this.g?.alive) this.g.end(commit);
    this.g = null;
  }

  key(values: Values, decimals: number): void {
    this.bridge.key(this.ref, values, decimals);
  }

  once(values: Values, decimals: number): void {
    this.bridge.once(this.ref, values, decimals);
  }
}
