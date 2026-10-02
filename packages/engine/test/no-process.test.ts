import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { reviewPullRequest } from '../src/review.js';
import { PR_7_URL, PR_8_URL, fixtureFetch, pull7, pull8, temporaryCacheDir } from './helpers.js';

// A file of its own, so the reviews below are the first in this module
// graph: the WASM runtime and grammars load while every way to start a
// process is watched. The second review exercises the parse-only lock
// file checks, which must read files and never run a package manager.

let cacheDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

/** Every way to start a process, mocked to throw the moment one is tried. */
function forbidProcesses(): { restore: () => void; spies: readonly MockInstance[] } {
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
  return {
    spies,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
      syncBuiltinESMExports();
    },
  };
}

describe('a review', () => {
  it('runs no process: no pull request code and no package manager', async () => {
    const guard = forbidProcesses();
    try {
      await reviewPullRequest(PR_7_URL, {
        token: 'test-token',
        fetch: fixtureFetch(pull7()).fetch,
        cacheDir,
      });
    } finally {
      guard.restore();
    }
    for (const spy of guard.spies) expect(spy).not.toHaveBeenCalled();
  });

  it('confirms lock file noise without starting a package manager', async () => {
    const guard = forbidProcesses();
    try {
      const result = await reviewPullRequest(PR_8_URL, {
        token: 'test-token',
        fetch: fixtureFetch(pull8()).fetch,
        cacheDir,
      });
      // The parse-only checks really ran: one lock file confirmed.
      expect(
        result.parts.some(
          (part) =>
            part.noise?.label === 'lockfile' && part.noise.state === 'confirmed',
        ),
      ).toBe(true);
    } finally {
      guard.restore();
    }
    for (const spy of guard.spies) expect(spy).not.toHaveBeenCalled();
  });
});
