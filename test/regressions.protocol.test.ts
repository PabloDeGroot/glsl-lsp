// Refresh requests for semantic tokens / inlay hints when other files change.
import { describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../server/src/context';
import type { ModelChangeEvent } from '../server/src/core';
import { onDependentsChanged } from '../server/src/features/refresh';
import { uri } from './helpers';

function fakeCtx(open: string[]) {
  const modelListeners: ((e: ModelChangeEvent) => void)[] = [];
  const indexedListeners: (() => void)[] = [];
  const ctx = {
    documents: { all: () => open.map((u) => ({ uri: u })) },
    log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    onModelChanged: (l: (e: ModelChangeEvent) => void) => (modelListeners.push(l), { dispose() {} }),
    onIndexed: (l: () => void) => (indexedListeners.push(l), { dispose() {} }),
  } as unknown as ServerContext;
  return { ctx, fire: (e: ModelChangeEvent) => modelListeners.forEach((l) => l(e)), indexed: () => indexedListeners.forEach((l) => l()) };
}

describe('refresh on dependent changes', () => {
  it('refreshes (debounced) when an included file of an open document changes, never rejects unhandled', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, fire, indexed } = fakeCtx([uri('a.glsl'), uri('b.glsl')]);
      const refresh = vi.fn(() => Promise.reject(new Error('Unhandled method workspace/inlayHint/refresh')));
      onDependentsChanged(ctx, () => true, refresh, 'test');
      fire({ uri: uri('a.glsl'), affected: [uri('a.glsl')] }); // own edit only: no refresh
      await vi.advanceTimersByTimeAsync(500);
      expect(refresh).not.toHaveBeenCalled();
      fire({ uri: uri('b.glsl'), affected: [uri('b.glsl'), uri('a.glsl')] });
      fire({ uri: uri('b.glsl'), affected: [uri('b.glsl'), uri('a.glsl')] });
      await vi.advanceTimersByTimeAsync(500);
      expect(refresh).toHaveBeenCalledTimes(1);
      indexed();
      await vi.advanceTimersByTimeAsync(500);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(ctx.log.debug).toHaveBeenCalled(); // the rejection was caught and logged
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when the client has no refresh support', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, indexed } = fakeCtx([uri('a.glsl')]);
      const refresh = vi.fn();
      onDependentsChanged(ctx, () => false, refresh, 'test');
      indexed();
      await vi.advanceTimersByTimeAsync(500);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
