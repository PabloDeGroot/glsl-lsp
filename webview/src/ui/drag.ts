// Pointer-capture dragging with Escape-to-cancel, an optional movement
// threshold before the drag starts, and optional pointer lock (endless
// scrubbing).

export interface DragHandlers {
  /**
   * Return false to ignore this press. With a `threshold` this runs on the
   * first pointermove past it: check buttons on `down` (the pointerdown), not
   * on `e` (a pointermove reports `button === -1`).
   */
  start(e: PointerEvent, down: PointerEvent): boolean | void;
  move(e: PointerEvent): void;
  end(e: PointerEvent | null, cancelled: boolean): void;
  /** Minimum movement in px before `start` fires (default 0 = immediately on press). */
  threshold?: number;
  /** Called on a press released without passing the threshold. */
  click?(e: PointerEvent): void;
  /**
   * Request pointer lock once the drag started (scrubbing past the screen
   * edge). Engaging the lock releases pointer capture; that is not the end of
   * the drag. Losing the lock mid-drag (Escape) cancels it.
   */
  pointerLock?: boolean;
}

/** Wires drag handling on `el`. Returns a disposer. */
export function draggable(el: HTMLElement, hd: DragHandlers): () => void {
  let active: { id: number; x: number; y: number; started: boolean; down: PointerEvent; lock: 'none' | 'pending' | 'on' } | null = null;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && active) {
      e.preventDefault();
      e.stopPropagation();
      finish(null, true);
    }
  };

  const onLockChange = () => {
    if (!active || active.lock === 'none') return;
    if (document.pointerLockElement === el) active.lock = 'on';
    else if (active.lock === 'on') finish(null, true); // lock lost mid-drag (Escape, focus loss)
    else active.lock = 'none';
  };
  const onLockError = () => {
    if (active) active.lock = 'none';
  };

  const finish = (e: PointerEvent | null, cancelled: boolean) => {
    if (!active) return;
    const a = active;
    active = null;
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerlockchange', onLockChange);
    document.removeEventListener('pointerlockerror', onLockError);
    if (document.pointerLockElement === el) {
      try {
        document.exitPointerLock();
      } catch {
        /* ignore */
      }
    }
    try {
      if (el.hasPointerCapture(a.id)) el.releasePointerCapture(a.id);
    } catch {
      /* ignore */
    }
    el.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    if (a.started) hd.end(e, cancelled);
    else if (e && !cancelled) hd.click?.(e);
  };

  const begin = (e: PointerEvent): boolean => {
    if (!active) return false;
    if (hd.start(e, active.down) === false) return false;
    active.started = true;
    el.classList.add('dragging');
    document.body.classList.add('is-dragging');
    if (hd.pointerLock && typeof el.requestPointerLock === 'function') {
      active.lock = 'pending';
      document.addEventListener('pointerlockchange', onLockChange);
      document.addEventListener('pointerlockerror', onLockError);
      try {
        const p = el.requestPointerLock() as unknown as Promise<void> | undefined;
        p?.catch?.(() => onLockError());
      } catch {
        onLockError();
      }
    }
    return true;
  };

  const down = (e: PointerEvent) => {
    if (active) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    active = { id: e.pointerId, x: e.clientX, y: e.clientY, started: false, down: e, lock: 'none' };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    window.addEventListener('keydown', onKey, true);
    if (!hd.threshold) {
      if (!begin(e)) {
        active = null;
        window.removeEventListener('keydown', onKey, true);
        return;
      }
      e.preventDefault();
    }
  };

  const move = (e: PointerEvent) => {
    if (!active || e.pointerId !== active.id) return;
    if (!active.started) {
      if (Math.hypot(e.clientX - active.x, e.clientY - active.y) < (hd.threshold ?? 0)) return;
      if (!begin(e)) {
        finish(null, true);
        return;
      }
    }
    hd.move(e);
  };

  const up = (e: PointerEvent) => {
    if (!active || e.pointerId !== active.id) return;
    finish(e, false);
  };
  const cancel = (e: PointerEvent) => {
    if (!active || e.pointerId !== active.id) return;
    finish(e, true);
  };
  const lost = (e: PointerEvent) => {
    if (!active || e.pointerId !== active.id) return;
    // Engaging pointer lock releases capture: the drag goes on (events now target the locked element).
    if (active.lock !== 'none' || document.pointerLockElement === el) return;
    finish(null, false);
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('lostpointercapture', lost);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('lostpointercapture', lost);
  };
}
