// WebviewViewProvider for the `glslLsp.values` view: serves the HTML shell
// (html.ts), forwards webview messages to the controller and posts its
// StateMessages back through `post`.

import { Disposable, Uri, type WebviewView, type WebviewViewProvider } from 'vscode';
import type { ExtensionToWebview, WebviewToExtension } from '../../../shared/valuesProtocol';
import { isWebviewMessage } from '../../../shared/valuesProtocol';
import { valuesHtml } from './html';

export const VALUES_VIEW_ID = 'glslLsp.values';

export class ValuesViewProvider implements WebviewViewProvider, Disposable {
  private view: WebviewView | undefined;
  private readonly disposables: Disposable[] = [];

  constructor(
    private readonly extensionUri: Uri,
    private readonly onMessage: (message: WebviewToExtension) => void,
    private readonly onVisibilityChange: (visible: boolean) => void = () => {},
    private readonly onViewDisposed: () => void = () => {},
  ) {}

  /** Listeners of the current view instance (disposed with it). */
  private viewDisposables: Disposable[] = [];

  /** True once VS Code created the view (it was opened at least once). */
  get resolved(): boolean {
    return !!this.view;
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  resolveWebviewView(view: WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(this.extensionUri, 'dist'), Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = valuesHtml(view.webview, this.extensionUri);
    for (const d of this.viewDisposables.splice(0)) d.dispose();
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((m: unknown) => {
        if (isWebviewMessage(m)) this.onMessage(m);
      }),
      view.onDidChangeVisibility(() => this.onVisibilityChange(view.visible)),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
        for (const d of this.viewDisposables.splice(0)) d.dispose();
        this.onVisibilityChange(false);
        this.onViewDisposed();
      }),
    );
  }

  /** Posts to the webview; false when the view is not resolved (hidden views keep their context). */
  post(message: ExtensionToWebview): Thenable<boolean> | false {
    return this.view ? this.view.webview.postMessage(message) : false;
  }

  /** Reveals the view (and its container) without stealing focus unless asked. */
  show(preserveFocus = true): void {
    this.view?.show(preserveFocus);
  }

  dispose(): void {
    for (const d of this.viewDisposables.splice(0)) d.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
