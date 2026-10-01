import { describe, expect, it } from 'vitest';
import { REVIEW_RESULT_VERSION } from '../src/protocol.js';
import { reviewPullRequest } from '../src/review.js';
import { PR_URL, fixtureFetch } from './helpers.js';

describe('reviewPullRequest', () => {
  it('returns a versioned review result with one part per file', async () => {
    const result = await reviewPullRequest(PR_URL, {
      token: 'test-token',
      fetch: fixtureFetch().fetch,
    });

    expect(result.version).toBe(REVIEW_RESULT_VERSION);
    expect(result.version).toBe(1);
    expect(result.pullRequest.number).toBe(42);
    expect(result.pullRequest.description).toHaveLength(8082);

    // One part per changed file, no duplicates, matching the diff's files.
    const paths = result.parts.map((part) => part.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual([
      'README.md',
      'src/settings.ts',
      'src/legacy.ts',
      'src/fresh.ts',
      'assets/logo.png',
      'notes.txt',
      'scripts/run.sh',
      'package-lock.json',
    ]);
  });

  it('proves coverage before returning, and survives JSON round trips', async () => {
    const result = await reviewPullRequest(PR_URL, {
      token: 'test-token',
      fetch: fixtureFetch().fetch,
    });
    const roundTripped: unknown = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toEqual(result);
  });

  it('rejects input that is not a pull request URL', async () => {
    await expect(
      reviewPullRequest('https://github.com/example-org/example-repo', {
        token: 'test-token',
        fetch: fixtureFetch().fetch,
      }),
    ).rejects.toThrow(/not a GitHub pull request URL/);
  });
});
