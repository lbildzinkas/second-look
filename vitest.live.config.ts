import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The opt-in live suite for the companion's Claude Code guard. It drives
 * the reviewer's real, signed-in Claude Code and spends subscription
 * quota, so it never runs in the default checks (`npm test`,
 * `npm run check`) or in CI; a developer opts in explicitly with
 * `npm run test:live-claude`.
 */
export default defineConfig({
  test: {
    include: ['packages/engine/test/live/**/*.live.test.ts'],
    environment: 'node',
    // One live run at a time, so the quota spent stays modest and visible.
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
