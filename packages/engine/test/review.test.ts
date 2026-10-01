import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { REVIEW_RESULT_VERSION } from '../src/protocol.js';
import type { Part } from '../src/protocol.js';
import { reviewPullRequest } from '../src/review.js';
import { PR_7_URL, PR_URL, fixtureFetch, pull7, temporaryCacheDir } from './helpers.js';

let cacheDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

describe('reviewPullRequest', () => {
  it('returns a versioned review result with one part per file', async () => {
    const result = await reviewPullRequest(PR_URL, {
      token: 'test-token',
      fetch: fixtureFetch().fetch,
      cacheDir,
    });

    expect(result.version).toBe(REVIEW_RESULT_VERSION);
    expect(result.version).toBe(2);
    expect(result.pullRequest.number).toBe(42);
    expect(result.pullRequest.description).toHaveLength(8082);
    // The head commit's SHA, where the noise attributes are read.
    expect(result.pullRequest.headSha).toBe(
      'f00dcafe1234567890abcdef1234567890abcdef',
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
      cacheDir,
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
      cacheDir,
    });
    const roundTripped: unknown = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toEqual(result);
  });

  it('rejects input that is not a pull request URL', async () => {
    await expect(
      reviewPullRequest('https://github.com/example-org/example-repo', {
        token: 'test-token',
        fetch: fixtureFetch().fetch,
        cacheDir,
      }),
    ).rejects.toThrow(/not a GitHub pull request URL/);
  });
});

describe('read-only copies', () => {
  /** Every folder and file under a copy, with its permission bits. */
  function modes(dir: string): { path: string; mode: number; isFile: boolean }[] {
    const found = [{ path: dir, mode: statSync(dir).mode & 0o777, isFile: false }];
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name);
      found.push({ path, mode: statSync(path).mode & 0o777, isFile: entry.isFile() });
    }
    return found;
  }

  it('takes the base copy at the merge base and the head copy at the head commit', async () => {
    const pull = pull7();
    const transport = fixtureFetch(pull);
    const result = await reviewPullRequest(PR_7_URL, {
      token: 'test-token',
      fetch: transport.fetch,
      cacheDir,
    });

    expect(result.copies.base.commit).toBe(pull.mergeBase);
    expect(result.copies.head.commit).toBe(pull.headSha);
    expect(result.copies.base.path).toBe(
      join(cacheDir, 'github.com', 'example-org', 'example-repo', 'pull-7', pull.mergeBase),
    );
    const tarballs = transport.requests.filter((request) => request.url.includes('/tarball/'));
    expect(tarballs.map((request) => request.url.split('/').at(-1)).sort()).toEqual(
      [pull.mergeBase, pull.headSha].sort(),
    );
  });

  it('keeps the copies read-only and never executable', async () => {
    const result = await reviewPullRequest(PR_7_URL, {
      token: 'test-token',
      fetch: fixtureFetch(pull7()).fetch,
      cacheDir,
    });
    for (const copy of [result.copies.base, result.copies.head]) {
      const entries = modes(copy.path);
      expect(entries.filter((entry) => entry.isFile).length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.mode & 0o222, entry.path).toBe(0);
        if (entry.isFile) expect(entry.mode & 0o111, entry.path).toBe(0);
      }
    }
  });

  it('reuses the copies on the next run at the same commits', async () => {
    const first = await reviewPullRequest(PR_7_URL, {
      token: 'test-token',
      fetch: fixtureFetch(pull7()).fetch,
      cacheDir,
    });
    expect(first.copies.base.reused).toBe(false);
    expect(first.copies.head.reused).toBe(false);

    const transport = fixtureFetch(pull7());
    const second = await reviewPullRequest(PR_7_URL, {
      token: 'test-token',
      fetch: transport.fetch,
      cacheDir,
    });
    expect(second.copies.base).toEqual({ ...first.copies.base, reused: true });
    expect(second.copies.head).toEqual({ ...first.copies.head, reused: true });
    expect(transport.requests.some((request) => request.url.includes('/tarball/'))).toBe(false);
  });
});

describe('the syntax pass in a review', () => {
  async function partsByPath(): Promise<{ parts: Map<string, Part>; parseTimeMs: number }> {
    const result = await reviewPullRequest(PR_7_URL, {
      token: 'test-token',
      fetch: fixtureFetch(pull7()).fetch,
      cacheDir,
    });
    return {
      parts: new Map(result.parts.map((part) => [part.path, part])),
      parseTimeMs: result.parseTimeMs,
    };
  }

  it('confirms the Python reformat and the C# restyle as formatting-only', async () => {
    const { parts } = await partsByPath();
    expect(parts.get('app/reformat.py')!.syntax.formattingOnly.status).toBe('confirmed');
    expect(parts.get('src/Greeter.cs')!.syntax.formattingOnly.status).toBe('confirmed');
  });

  it('does not confirm the dedent that moves a statement out of its block', async () => {
    const { parts } = await partsByPath();
    const dedent = parts.get('app/dedent.py')!;
    expect(dedent.syntax.formattingOnly).toEqual({
      status: 'structure-changed',
      reason: 'the syntax tree changes at head line 4',
    });
    expect(dedent.hunks[0]!.entities).toEqual([{ kind: 'function', name: 'apply_discount' }]);
  });

  it('names the entities each hunk touches', async () => {
    const { parts } = await partsByPath();
    expect(parts.get('web/cart.ts')!.hunks[0]!.entities).toEqual([
      { kind: 'method', name: 'Cart.total' },
    ]);
    expect(parts.get('app/fresh.py')!.hunks[0]!.entities).toEqual([
      { kind: 'function', name: 'fresh' },
    ]);
    expect(parts.get('app/reformat.py')!.hunks[0]!.entities).toEqual([
      { kind: 'function', name: 'load' },
      { kind: 'class', name: 'Store' },
      { kind: 'method', name: 'Store.__init__' },
      { kind: 'method', name: 'Store.path_for' },
    ]);
  });

  it('lets a file without a grammar flow through and says which checks did not run', async () => {
    const { parts } = await partsByPath();
    const ruby = parts.get('scripts/deploy.rb')!;
    expect(ruby.hunks[0]!.entities).toEqual([]);
    expect(ruby.syntax.checksNotRun.map((check) => check.check)).toEqual([
      'entities',
      'formatting-only',
    ]);
    expect(ruby.syntax.checksNotRun[0]!.reason).toContain('no grammar for ".rb" files');
  });

  it('records the parse time', async () => {
    const { parseTimeMs } = await partsByPath();
    expect(parseTimeMs).toBeGreaterThan(0);
  });
});
