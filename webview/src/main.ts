// Values panel webview entry: bootstrap, message pump, layout shell
// (list + widget area), render scheduling (one per animation frame).
// Bundled by scripts/build.mjs to dist/webview.js (+ dist/webview.css).

import './styles.css';
import type { ExtensionToWebview, TargetRef, WebviewToExtension } from '../../shared/valuesProtocol';
import { CURSOR_ROW_ID } from '../../shared/valuesProtocol';
import { Bridge } from './bridge';
import { List } from './list/List';
import { sameRef } from './math/targets';
import { UiState, type VsApi } from './persist';
import { Store } from './store';
import { h } from './ui/dom';
import { WidgetHost } from './widgets/Widget';

const vscode: VsApi = acquireVsCodeApi();
const post = (m: WebviewToExtension) => vscode.postMessage(m);

const ui = new UiState(vscode);
const store = new Store();
const bridge = new Bridge(post, store);

function select(ref: TargetRef): void {
  if (sameRef(store.selected.ref, ref)) return;
  store.select(ref);
  post({ type: 'select', ref });
}

function backToCursor(): void {
  if (store.selected.ref.rowId !== CURSOR_ROW_ID || store.selected.ref.childIndex !== undefined) select({ rowId: CURSOR_ROW_ID });
}

const list = new List({ store, bridge, ui, post, select, backToCursor });
const host = new WidgetHost({ store, bridge, ui, post, select });

const app = document.getElementById('app') ?? document.body.appendChild(h('div.app', { id: 'app' }));
app.classList.add('app');
app.replaceChildren(list.el, h('div.divider', { role: 'separator', 'aria-hidden': 'true' }), host.el);

let frame = 0;
function schedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    list.render();
    host.render();
  });
}
store.onChange(schedule);

bridge.onReject = () => host.refresh();

window.addEventListener('message', (e: MessageEvent<ExtensionToWebview>) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'state':
      store.setState(m);
      ui.data.last = m;
      ui.save();
      break;
    case 'editRejected':
      bridge.reject(m.gestureId);
      host.notice(m.reason, 'warning');
      break;
    case 'focusWidget':
      requestAnimationFrame(() => {
        if (!host.focus()) list.focus();
      });
      break;
    case 'notice':
      host.notice(m.text, m.severity);
      break;
  }
});

// Escape (idle, a pin selected) -> back to cursor. Inputs handle their own Escape first.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || bridge.busy) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.closest('.menu'))) return;
  backToCursor();
});

// Show the last known state immediately (no empty flash when the view is re-shown).
if (ui.data.last) store.setState(ui.data.last);
else schedule();

post({ type: 'ready' });
