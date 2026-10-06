// Bundles the extension client and the language server with esbuild.
//   node scripts/build.mjs               one-off development build
//   node scripts/build.mjs --watch       rebuild on change
//   node scripts/build.mjs --production  minified, no source maps
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

const configs = [
  { ...common, entryPoints: ['client/src/extension.ts'], outfile: 'dist/client.js', external: ['vscode'] },
  { ...common, entryPoints: ['server/src/server.ts'], outfile: 'dist/server.js' },
];

if (watch) {
  for (const config of configs) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
