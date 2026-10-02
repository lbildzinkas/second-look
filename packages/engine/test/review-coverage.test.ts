import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeCopy } from '../src/cache.js';
import type { Part } from '../src/protocol.js';
import { reviewPullRequest } from '../src/review.js';
import { PR_7_URL, fixtureFetch, pull7, temporaryCacheDir } from './helpers.js';

/** How the mocked grouping breaks the parts, if at all. */
const breakage = vi.hoisted(() => ({ fault: 'none' as 'none' | 'drop' | 'double' }));

vi.mock('../src/parts.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/parts.js')>();
  return {
    ...original,
    groupParts: (files: readonly Part[]): Part[] => {
      const parts = original.groupParts(files);
      if (breakage.fault === 'drop') return parts.slice(1);
      if (breakage.fault === 'double') return [...parts, parts[0]!];
      return parts;
    },
  };
});

let cacheDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
  breakage.fault = 'none';
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

function review(): Promise<unknown> {
  return reviewPullRequest(PR_7_URL, {
    token: 'test-token',
    fetch: fixtureFetch(pull7()).fetch,
    cacheDir,
  });
}

describe('the coverage validator in a review', () => {
  it('lets a run through when every changed line is in exactly one part', async () => {
    await expect(review()).resolves.toBeDefined();
  });

  it('fails the run when a changed line is in no part', async () => {
    breakage.fault = 'drop';
    await expect(review()).rejects.toThrow(
      /diff coverage check failed: app\/dedent\.py: changed line old:4 belongs to no part/,
    );
  });

  it('fails the run when a changed line is in two parts', async () => {
    breakage.fault = 'double';
    await expect(review()).rejects.toThrow(/belongs to more than one part/);
  });
});
