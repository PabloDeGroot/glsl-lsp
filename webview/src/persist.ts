// UI-only state persisted with vscode.setState (survives the view being
// hidden/reloaded): section collapse, trackball views, last state message.

import type { StateMessage } from '../../shared/valuesProtocol';
import type { View } from './math/vec';

export interface Persisted {
  collapsed: { cursor?: boolean; pinned?: boolean };
  /** Trackball view per row key. */
  views: Record<string, View>;
  /** Last state, rendered immediately on reload (no empty flash). */
  last?: StateMessage;
}

export interface VsApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export class UiState {
  data: Persisted;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly api: VsApi) {
    const s = api.getState() as Partial<Persisted> | undefined;
    this.data = { collapsed: s?.collapsed ?? {}, views: s?.views ?? {}, last: s?.last };
  }

  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.api.setState(this.data);
      } catch {
        /* state is a convenience */
      }
    }, 250);
  }
}
