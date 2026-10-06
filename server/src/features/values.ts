// Values panel support: custom request `glslLsp/valueTargets` (see
// shared/valuesProtocol.ts and docs/VALUES.md). Finds the editable value
// (float literal, vecN constructor, cosine palette, multi-literal statement)
// at the cursor, and re-finds pinned values from their anchors.
//
// No capability is advertised: the request is custom and only sent by our
// own client (client/src/values/*).
//
// The pure logic lives in ./values/*:
//   targets.ts   computeValueTargets(env, params): the request, minus I/O
//   scan.ts / literals.ts / vectors.ts / palette.ts / analysis.ts  detection
//   cursor.ts    which target is "at" the cursor
//   anchors.ts   pin anchor resolution (declaration -> fingerprint -> fuzzy)
//   build.ts / labels.ts  ValueTarget objects, names and snippets

import type { ServerContext } from '../context';
import { VALUE_TARGETS_REQUEST, type ValueTargetsParams, type ValueTargetsResult } from '../../../shared/valuesProtocol';
import { computeValueTargets } from './values/targets';

export { computeValueTargets } from './values/targets';

export function register(ctx: ServerContext): void {
  ctx.connection.onRequest(VALUE_TARGETS_REQUEST, (params: ValueTargetsParams): ValueTargetsResult => {
    try {
      return computeValueTargets(
        {
          getModel: (uri) => ctx.getModel(uri),
          getVersion: (uri) => ctx.getDocument(uri)?.version ?? null,
          workspace: ctx.workspace,
          colorsMode: ctx.settings.get().colors.mode,
        },
        params,
      );
    } catch (err) {
      ctx.log.error(`valueTargets failed: ${(err as Error).stack ?? err}`);
      return { uri: params.uri, version: null, cursor: params.position ? null : undefined };
    }
  });
}
