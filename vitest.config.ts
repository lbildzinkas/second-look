import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // Tests run against source, so no build is needed before `npm test`.
      '@second-look/engine': fileURLToPath(
        new URL('./packages/engine/src/index.ts', import.meta.url),
      ),
    },
  },
});
