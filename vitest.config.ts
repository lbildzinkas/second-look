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
    // The evaluation tests run whole recorded pull requests per test, so a
    // test that takes under a second locally can take several on a CI
    // runner slower than any dev machine; 30s keeps such a runner from
    // timing out a passing suite while a genuinely hung test still fails.
    testTimeout: 30_000,
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
