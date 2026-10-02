import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the tests at the top of each test/ directory run by default;
    // the extension integration test lives in test/integration and runs
    // in CI (under xvfb) or on explicit opt-in, never in a local check,
    // so no local run can launch anything that opens a VS Code window.
    include: ['packages/*/test/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // Tests run against source, so no build is needed before `npm test`.
      '@second-look/engine': fileURLToPath(
        new URL('./packages/engine/src/index.ts', import.meta.url),
      ),
      // The extension's VS Code API is a test double outside the editor.
      vscode: fileURLToPath(new URL('./packages/extension/test/vscode-stub.ts', import.meta.url)),
    },
  },
});
