import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The opt-in live suite for the sandboxed run. It starts real containers
 * through the docker or podman on the machine, so it never runs in the
 * default checks (`npm test`, `npm run check`); CI runs it on Linux,
 * where Docker is present, and a developer opts in explicitly with
 * `npm run test:sandbox`.
 */
export default defineConfig({
  test: {
    include: ['packages/engine/test/sandbox-live/**/*.live.test.ts'],
    environment: 'node',
    // The runs share one runtime and check what containers are left.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  resolve: {
    alias: {
      '@second-look/engine': fileURLToPath(
        new URL('./packages/engine/src/index.ts', import.meta.url),
      ),
    },
  },
});
