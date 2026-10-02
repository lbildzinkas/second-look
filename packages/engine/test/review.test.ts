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
    expect(result.version).toBe(2);
    expect(result.pullRequest.number).toBe(42);
    expect(result.pullRequest.description).toHaveLength(8082);
    // The head commit's SHA, where the noise attributes are read.
    expect(result.pullRequest.headSha).toBe(
      'f00dcafe1234567890abcdef1234567890abcdef12',
    );

    // One part per changed file, no duplicates. The noise parts sink to
    // the bottom in diff order; snapshots stay among the readable parts.
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
      'src/__snapshots__/review.test.ts.snap',
      'src/util/format.ts',
      'src/generated/options.json',
      'package-lock.json',
    ]);
  });

  it('labels every part, with the fixture pull request exercising each state', async () => {
    const result = await reviewPullRequest(PR_URL, {
      token: 'test-token',
      fetch: fixtureFetch().fetch,
    });
    const byPath = new Map(result.parts.map((part) => [part.path, part]));

    // The pure rename is confirmed noise: identical content, proved.
    expect(byPath.get('src/util/format.ts')!.noise).toEqual({
      label: 'moved or renamed',
      rule: 'rename-identical',
      state: 'confirmed',
      blindSpot: expect.any(String),
    });
    // The lockfile is claimed noise and sinks.
    expect(byPath.get('package-lock.json')!.noise).toEqual({
      label: 'lockfile',
      rule: 'lockfile-name',
      state: 'claimed',
      blindSpot: expect.any(String),
    });
    // The snapshot is labelled but never sunk, however it changed.
    expect(byPath.get('src/__snapshots__/review.test.ts.snap')!.noise).toEqual({
      label: 'snapshot',
      rule: 'snapshot-name',
      state: 'claimed',
      blindSpot: expect.any(String),
    });
    // The linguist declaration from the head commit is honoured.
    expect(byPath.get('src/generated/options.json')!.noise).toEqual({
      label: 'generated',
      rule: 'linguist-generated',
      state: 'claimed',
      blindSpot: expect.any(String),
    });
    // The rename with edits is not noise, and the result says so.
    expect(byPath.get('src/settings.ts')!.noise).toEqual({
      label: 'none',
      note: 'no rule applied',
    });
    expect(byPath.get('README.md')!.noise).toEqual({ label: 'none', note: 'no rule applied' });
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
