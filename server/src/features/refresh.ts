// Asks the client to re-request semantic tokens / inlay hints of open
// documents whose results depend on other files: an included file changed,
// declarations appeared elsewhere, or the initial index finished. Debounced
// and guarded by the client's refreshSupport capability.

import type { ServerContext } from '../context';
import { normalizeUri } from '../core';

const DEBOUNCE_MS = 250;

/**
 * Calls `refresh` (debounced) whenever an open document other than the edited
 * one is affected by a model change, when declared names change, and after
 * indexing. Returns `trigger` for other callers (e.g. setting changes).
 */
export function onDependentsChanged(ctx: ServerContext, supported: () => boolean, refresh: () => unknown, name: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const trigger = () => {
    if (!supported()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      Promise.resolve()
        .then(refresh)
        .catch((err: unknown) => ctx.log.debug(`${name} refresh failed: ${(err as Error)?.message ?? err}`));
    }, DEBOUNCE_MS);
  };
  ctx.onModelChanged((e) => {
    if (e.namesChanged) return trigger();
    const open = new Set(ctx.documents.all().map((d) => normalizeUri(d.uri)));
    if (e.affected.some((u) => u !== e.uri && open.has(u))) trigger();
  });
  ctx.onIndexed(trigger);
  return trigger;
}
