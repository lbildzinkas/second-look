import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pullRequestCacheDir, removeCopy } from '../src/cache.js';
import type { PullRequestRef } from '../src/github.js';
import { REVIEW_RESULT_VERSION, type ReviewResult } from '../src/protocol.js';
import { SAVED_REVIEW_FILE, readSavedReview, saveReview } from '../src/saved-review.js';
import { temporaryCacheDir } from './helpers.js';

const REF: PullRequestRef = { owner: 'example-org', repo: 'example-repo', number: 42 };
const HEAD = 'f00dcafe1234567890abcdef1234567890abcdef';
const STAMP = { reviewedAt: '2026-10-12T09:00:00.000Z', agent: { agent: 'pi', model: 'pi/model', effort: null } };

/** The least of a review result the store reads: its version, its pull request's head commit, its copies and its parts. */
function result(headSha = HEAD): ReviewResult {
  return {
    version: REVIEW_RESULT_VERSION,
    pullRequest: { url: 'https://github.com/example-org/example-repo/pull/42', number: 42, headSha },
    copies: { base: { commit: 'b'.repeat(40), path: '/cache/base', reused: false }, head: { commit: headSha, path: '/cache/head', reused: false } },
    parts: [],
  } as unknown as ReviewResult;
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

async function writeRecord(record: unknown): Promise<void> {
  await mkdir(pullRequestCacheDir(cacheDir, REF), { recursive: true });
  await writeFile(join(pullRequestCacheDir(cacheDir, REF), SAVED_REVIEW_FILE), typeof record === 'string' ? record : JSON.stringify(record), 'utf8');
}

describe('the saved review', () => {
  it('reads back the result it saved, keyed by the result version and the head commit, with who produced it and without a label', async () => {
    await saveReview(cacheDir, REF, { ...result(), saved: { ...STAMP, newHead: 'c'.repeat(40) } }, STAMP);

    expect(await readSavedReview(cacheDir, REF)).toEqual({ version: REVIEW_RESULT_VERSION, commit: HEAD, ...STAMP, result: result() });
  });

  it('reads nothing before any review was saved', async () => {
    expect(await readSavedReview(cacheDir, REF)).toBeNull();
  });

  it('leaves out a record of another result version, of another commit than its result, or that is no record', async () => {
    for (const record of [
      { version: REVIEW_RESULT_VERSION - 1, commit: HEAD, ...STAMP, result: { ...result(), version: REVIEW_RESULT_VERSION - 1 } },
      { version: REVIEW_RESULT_VERSION, commit: HEAD, ...STAMP, result: { ...result(), version: REVIEW_RESULT_VERSION - 1 } },
      { version: REVIEW_RESULT_VERSION, commit: 'c'.repeat(40), ...STAMP, result: result() },
      { version: REVIEW_RESULT_VERSION, commit: HEAD, result: result() },
      { version: REVIEW_RESULT_VERSION, commit: HEAD, ...STAMP, result: { ...result(), parts: undefined } },
      'not json',
      null,
    ]) {
      await writeRecord(record);
      expect(await readSavedReview(cacheDir, REF)).toBeNull();
    }
  });
});
