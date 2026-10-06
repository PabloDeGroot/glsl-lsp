// Bundles the extension client, the language server and the Values panel
// webview with esbuild.
//   node scripts/build.mjs               one-off development build
//   node scripts/build.mjs --watch       rebuild on change
//   node scripts/build.mjs --production  minified, no source maps
//
// Outputs:
//   dist/client.js    extension host (node, cjs; `vscode` external)
//   dist/server.js    language server (node, cjs)
//   dist/webview.js   Values panel script (browser, iife)
//   dist/webview.css  Values panel styles (CSS imported from webview/src/main.ts)
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  ...common,
  entryPoints: { webview: 'webview/src/main.ts' },
  outdir: 'dist',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  // Inline sourcemaps: the webview cannot fetch .map files outside localResourceRoots reliably.
  sourcemap: production ? false : 'inline',
  loader: { '.svg': 'text' },
};

const configs = [
  { ...common, entryPoints: ['client/src/extension.ts'], outfile: 'dist/client.js', external: ['vscode'] },
  { ...common, entryPoints: ['server/src/server.ts'], outfile: 'dist/server.js' },
  webview,
];

if (watch) {
  for (const config of configs) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
