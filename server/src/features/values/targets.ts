// Computes the `glslLsp/valueTargets` response. Pure: everything it needs
// comes through ValuesEnv, so tests can drive it with an in-memory Workspace
// (test/helpers.ts makeWorkspace).

import type { AnchorResolution, ValueTargetsParams, ValueTargetsResult } from '../../../../shared/valuesProtocol';
import { analyze } from './analysis';
import { resolveAnchor } from './anchors';
import { cursorTarget } from './cursor';
import type { ValuesEnv } from './types';

export type { ValuesEnv } from './types';

export function computeValueTargets(env: ValuesEnv, params: ValueTargetsParams): ValueTargetsResult {
  const result: ValueTargetsResult = { uri: params.uri, version: env.getVersion(params.uri) };
  const model = env.getModel(params.uri);
  const a = model ? analyze(model) : undefined;
  if (params.position) result.cursor = a ? cursorTarget(env, a, params.position) : null;
  if (params.anchors) {
    result.anchors = params.anchors.map(
      (anchor): AnchorResolution => (a ? resolveAnchor(env, a, anchor) : { target: null, anchor, match: 'none' }),
    );
  }
  return result;
}
