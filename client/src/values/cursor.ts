// Tracks the active GLSL editor and its cursor. Emits debounced change events;
// the controller turns them into glslLsp/valueTargets requests.

import { EventEmitter, window, type Disposable, type Event, type TextEditor } from 'vscode';

export type CursorChangeKind = 'editor' | 'selection';

export function isGlslEditor(e: TextEditor | undefined): e is TextEditor {
  return !!e && e.document.languageId === 'glsl' && e.document.uri.scheme !== 'output';
}

export class CursorTracker implements Disposable {
  private current: TextEditor | undefined;
  private readonly emitter = new EventEmitter<CursorChangeKind>();
  private readonly disposables: Disposable[] = [];
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;

  readonly onDidChange: Event<CursorChangeKind> = this.emitter.event;

  constructor(
    private readonly selectionDebounceMs = 60,
  ) {
    this.current = isGlslEditor(window.activeTextEditor) ? window.activeTextEditor : undefined;
    this.disposables.push(
      window.onDidChangeActiveTextEditor((e) => {
        if (isGlslEditor(e)) {
          this.current = e;
          this.emitter.fire('editor');
        } else if (e && this.current && !window.visibleTextEditors.includes(this.current)) {
          this.current = undefined; // another kind of editor replaced it
          this.emitter.fire('editor');
        }
        // e === undefined (focus in a webview / panel): keep the last GLSL editor.
      }),
      window.onDidChangeVisibleTextEditors(() => {
        if (this.current && !window.visibleTextEditors.some((e) => e.document === this.current!.document)) {
          this.current = undefined;
          this.emitter.fire('editor');
        }
      }),
      window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor !== this.current) return;
        if (this.selectionTimer) clearTimeout(this.selectionTimer);
        this.selectionTimer = setTimeout(() => this.emitter.fire('selection'), this.selectionDebounceMs);
      }),
    );
  }

  /** Last/active GLSL editor, or undefined. */
  get editor(): TextEditor | undefined {
    if (this.current && this.current.document.isClosed) this.current = undefined;
    return this.current;
  }

  get uri(): string | undefined {
    return this.editor?.document.uri.toString();
  }

  dispose(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    for (const d of this.disposables.splice(0)) d.dispose();
    this.emitter.dispose();
  }
}
