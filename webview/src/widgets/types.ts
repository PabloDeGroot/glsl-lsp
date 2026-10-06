// Widget contract shared by every value widget.

import type { RowOptions, RowState, TargetRef, ValueTarget, ValuesSettings } from '../../../shared/valuesProtocol';
import type { Bridge } from '../bridge';
import type { UiState } from '../persist';

export interface WidgetContext {
  ref: TargetRef;
  row: RowState;
  target: ValueTarget;
  /** Options of the row (child refs share the parent's options). */
  options: RowOptions;
  settings: ValuesSettings;
  bridge: Bridge;
  ui: UiState;
  /** Stable key of this widget instance (persisted UI state such as trackball views). */
  key: string;
  /** Reset point of a target (captured at its first selection / gesture, per target, not per widget). */
  resetPoint(target: ValueTarget): number[];
  setOptions(options: RowOptions): void;
  select(ref: TargetRef): void;
  notice(text: string, severity?: 'info' | 'warning'): void;
}

export interface Widget {
  readonly el: HTMLElement;
  /** New state for the same target (values may have changed). Must not disturb an active drag/focused input. */
  update(ctx: WidgetContext): void;
  /** Keyboard focus to the main control. */
  focus(): void;
  dispose(): void;
}
