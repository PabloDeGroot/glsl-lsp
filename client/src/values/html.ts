// HTML shell of the Values webview: strict CSP with a per-load nonce, loads
// dist/webview.css and dist/webview.js (built from webview/src by
// scripts/build.mjs). Everything else is created by the script.

import { Uri, type Webview } from 'vscode';

export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function valuesHtml(webview: Webview, extensionUri: Uri): string {
  const nonce = makeNonce();
  const script = webview.asWebviewUri(Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const style = webview.asWebviewUri(Uri.joinPath(extensionUri, 'dist', 'webview.css'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>GLSL Values</title>
</head>
<body>
<div id="app" class="app" role="application" aria-label="GLSL values"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
