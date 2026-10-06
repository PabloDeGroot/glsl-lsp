import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Client modules import `vscode`; unit tests get a small in-memory stand-in.
    alias: { vscode: fileURLToPath(new URL('./test/mocks/vscode.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
