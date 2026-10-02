import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { reviewPullRequest } from '../src/review.js';
import { PR_7_URL, fixtureFetch, pull7, temporaryCacheDir } from './helpers.js';

// A file of its own, so the review below is the first in this module graph:
// the WASM runtime and grammars load while every way to start a process is
// watched.

let cacheDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

describe('a review', () => {
  it('runs no process: no pull request code and no package manager', async () => {
    const names = [
      'spawn',
      'spawnSync',
      'exec',
      'execSync',
      'execFile',
      'execFileSync',
      'fork',
    ] as const;
    const spies = names.map((name) =>
      vi.spyOn(childProcess, name).mockImplementation(() => {
        throw new Error(`the review tried to start a process with ${name}`);
      }),
    );
    syncBuiltinESMExports();
    try {
      await reviewPullRequest(PR_7_URL, {
        token: 'test-token',
        fetch: fixtureFetch(pull7()).fetch,
        cacheDir,
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
      syncBuiltinESMExports();
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
