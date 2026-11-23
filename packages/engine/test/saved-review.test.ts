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
function result(headSha = HEAD, named: { head?: string; title?: string; description?: string } = {}): ReviewResult {
  return {
    version: REVIEW_RESULT_VERSION,
    pullRequest: {
      url: 'https://github.com/example-org/example-repo/pull/42',
      number: 42,
      headSha,
      head: named.head ?? 'feature/retries',
      title: named.title ?? 'Retry webhook sends',
      description: named.description ?? '',
    },
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

  it('reads a record saved at version 25 as the current version, each linked issue GitHub’s with the key it is shown by', async () => {
    const detail = '1 issue this pull request closes and 1 issue that references it';
    const own = { number: 30, title: 'Retry', url: 'https://github.com/example-org/example-repo/issues/30', repository: 'example-org/example-repo', body: '- [ ] retried', link: 'closes' };
    const elsewhere = { number: 7, title: 'Track', url: 'https://github.com/example-org/planning/issues/7', repository: 'example-org/planning', body: '', link: 'references' };
    const criteria = { outcome: 'read', detail, heading: 'Acceptance criteria', issues: [own, elsewhere], criteria: [] };
    await writeRecord({ version: 25, commit: HEAD, ...STAMP, result: { ...result(), version: 25, criteria } });

    expect(await readSavedReview(cacheDir, REF)).toEqual({
      version: REVIEW_RESULT_VERSION,
      commit: HEAD,
      ...STAMP,
      result: {
        ...result(),
        criteria: {
          ...criteria,
          sources: [{ source: 'github', outcome: 'read', detail }],
          keyReferences: [],
          issues: [
            { source: 'github', key: '#30', ...own },
            { source: 'github', key: 'example-org/planning#7', ...elsewhere },
          ],
        },
      },
    });

    // A version-25 result that read no criteria is read as it was.
    await writeRecord({ version: 25, commit: HEAD, ...STAMP, result: { ...result(), version: 25 } });
    expect(await readSavedReview(cacheDir, REF)).toEqual({ version: REVIEW_RESULT_VERSION, commit: HEAD, ...STAMP, result: result() });
  });

  it('reads a record saved at version 26 as the current version, with the key references its pull request makes', async () => {
    const named = { head: 'feature/PORT-42_login', title: 'ABC-7: fix the login', description: 'Uses SHA-256. See https://x.atlassian.net/browse/PORT-42' };
    const detail = 'this pull request links no issue';
    const criteria = { outcome: 'read', detail, sources: [{ source: 'github', outcome: 'read', detail }], heading: 'Acceptance criteria', issues: [], criteria: [] };
    await writeRecord({ version: 26, commit: HEAD, ...STAMP, result: { ...result(HEAD, named), version: 26, criteria } });

    expect(await readSavedReview(cacheDir, REF)).toEqual({
      version: REVIEW_RESULT_VERSION,
      commit: HEAD,
      ...STAMP,
      result: {
        ...result(HEAD, named),
        criteria: {
          ...criteria,
          keyReferences: [
            { key: 'PORT-42', place: 'branch' },
            { key: 'ABC-7', place: 'title' },
          ],
        },
      },
    });
  });

  it('leaves out a record of another result version, of another commit than its result, or that is no record', async () => {
    for (const record of [
      { version: 24, commit: HEAD, ...STAMP, result: { ...result(), version: 24 } },
      { version: REVIEW_RESULT_VERSION, commit: HEAD, ...STAMP, result: { ...result(), version: 25 } },
      { version: 25, commit: HEAD, ...STAMP, result: { ...result(), version: REVIEW_RESULT_VERSION } },
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
