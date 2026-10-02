import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The opt-in suite for the extension integration test. It never runs in
 * the default checks (`npm test`, `npm run check`); CI runs it on Linux
 * under xvfb, and a developer opts in explicitly with
 * `npm run test:integration`. Nothing in a default local run launches
 * anything that could open a VS Code window.
 */
export default defineConfig({
  test: {
    include: ['packages/extension/test/integration/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@second-look/engine': fileURLToPath(
        new URL('./packages/engine/src/index.ts', import.meta.url),
      ),
      vscode: fileURLToPath(new URL('./packages/extension/test/vscode-stub.ts', import.meta.url)),
    },
  },
});
