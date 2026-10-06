// Values panel (client side): wiring only. See docs/VALUES.md.
//
//   provider.ts   WebviewViewProvider (HTML shell from html.ts, message pump)
//   controller.ts view model: cursor row + pins -> StateMessage, selection, messages
//   cursor.ts     tracks the active GLSL editor/selection
//   pins.ts       PinStore (workspaceState, PINS_STATE_KEY)
//   edits.ts      EditApplier: gestures, coalescing, one undo step per gesture
//   editText.ts   pure: component values -> replacement text
//   nudge*.ts     glslLsp.nudge* commands

import { commands, window, type ExtensionContext } from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import { VALUE_TARGETS_REQUEST, type ValueTargetsParams, type ValueTargetsResult } from '../../../shared/valuesProtocol';
import { ValuesController } from './controller';
import { nudgeNumbers } from './nudge';
import { nudgeFallback } from './nudgeCore';
import { VALUES_VIEW_ID, ValuesViewProvider } from './provider';


export function registerValues(context: ExtensionContext, getClient: () => LanguageClient | undefined): void {
  let controller: ValuesController | undefined;
  const provider = new ValuesViewProvider(
    context.extensionUri,
    (m) => controller?.handleMessage(m),
    (visible) => controller?.onVisibilityChange(visible),
    () => controller?.onViewDisposed(),
  );

  controller = new ValuesController(context, {
    request: async (params: ValueTargetsParams): Promise<ValueTargetsResult | undefined> => {
      const client = getClient();
      if (!client || client.state !== State.Running) return undefined;
      return client.sendRequest<ValueTargetsResult>(VALUE_TARGETS_REQUEST, params);
    },
    post: (m) => {
      void provider.post(m);
    },
    visible: () => provider.visible,
    reveal: () => {
      if (!provider.resolved) return false;
      provider.show(true);
      return true;
    },
  });

  const watchClient = () => {
    const client = getClient();
    if (!client) return undefined;
    return client.onDidChangeState((e) => {
      if (e.newState === State.Running) controller?.refreshAll();
    });
  };

  context.subscriptions.push(
    provider,
    controller,
    ...[watchClient()].filter((d) => !!d),
    window.registerWebviewViewProvider(VALUES_VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    commands.registerCommand('glslLsp.focusValues', async () => {
      await commands.executeCommand(`${VALUES_VIEW_ID}.focus`);
      controller?.refreshAll(); // also the manual refresh when glslLsp.values.followCursor is off
      controller?.focusWidget();
    }),
    commands.registerCommand('glslLsp.pinValue', () => controller?.pinAtCursor()),
    commands.registerCommand('glslLsp.clearPins', () => controller?.clearPins()),
    commands.registerCommand('glslLsp.nudgeUp', () => nudge(1, 1)),
    commands.registerCommand('glslLsp.nudgeDown', () => nudge(-1, 1)),
    commands.registerCommand('glslLsp.nudgeUpLarge', () => nudge(1, 10)),
    commands.registerCommand('glslLsp.nudgeDownLarge', () => nudge(-1, 10)),
  );

  function nudge(direction: 1 | -1, multiplier: number): void {
    if (nudgeNumbers(direction, multiplier)) {
      controller?.nudgeDone();
      return;
    }
    // Not on a number (or a multi-cursor run that is not all on numbers): do
    // what the key does by default on this platform, so the binding does not
    // swallow Add Cursor Above/Below (Windows) or column selection in GLSL files.
    const fallback = nudgeFallback(process.platform, `${direction > 0 ? 'up' : 'down'}${multiplier > 1 ? 'Large' : ''}`);
    if (fallback) void commands.executeCommand(fallback);
  }
}
