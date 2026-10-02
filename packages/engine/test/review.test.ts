import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { REVIEW_RESULT_VERSION } from '../src/protocol.js';
import type { Part } from '../src/protocol.js';
import { fetchChange, reviewChange, reviewPullRequest } from '../src/review.js';
import { PR_7_URL, PR_URL, fixtureFetch, pull7, temporaryCacheDir } from './helpers.js';

let cacheDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

describe('reviewPullRequest', () => {
  it('returns a versioned review result with named, ranked parts', async () => {
    const result = await reviewPullRequest(PR_URL, {
      token: 'test-token',
      fetch: fixtureFetch().fetch,
      cacheDir,
    });

    expect(result.version).toBe(REVIEW_RESULT_VERSION);
    expect(result.version).toBe(3);
    expect(result.pullRequest.number).toBe(42);
    expect(result.pullRequest.description).toHaveLength(8082);
    // The head commit's SHA, where the noise attributes are read.
    expect(result.pullRequest.headSha).toBe(
      'f00dcafe1234567890abcdef1234567890abcdef',
    );

    // Each file's hunks touch one group of entities here, so each file is
    // one part. The ranked parts come first; the noise parts sink to the
    // bottom in diff order, and snapshots stay among the ranked parts.
    const paths = result.parts.map((part) => part.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual([
      'src/fresh.ts',
      'README.md',
      'src/legacy.ts',
      'src/settings.ts',
      'notes.txt',
      'assets/logo.png',
      'scripts/run.sh',
      'src/__snapshots__/review.test.ts.snap',
      'src/util/format.ts',
      'src/generated/options.json',
      'package-lock.json',
    ]);
    for (const part of result.parts) {
      expect(part.name).toBeTruthy();
      expect(part.signals?.references.basis).toBe('name-based');
      expect(part.rank?.importance).toBeTruthy();
      expect(part.rank?.reason).toBeTruthy();
    }
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

  it('fetches once, then reviews the fetched change offline', async () => {
    const transport = fixtureFetch(pull7());
    const options = { token: 'test-token', fetch: transport.fetch, cacheDir };
    const input = await fetchChange(PR_7_URL, options);
    expect(input.gitAttributes).toBeNull();
    expect(input.diff).toMatch(/^diff --git a\/app\/dedent\.py/);
    const requests = transport.requests.length;

    const offline = await reviewChange(input);
    expect(transport.requests).toHaveLength(requests);
    expect(offline.parts).toEqual((await reviewPullRequest(PR_7_URL, options)).parts);
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
    expect(dedent.hunks[0]!.entities).toEqual([
      { kind: 'function', name: 'apply_discount', public: true, change: 'body' },
    ]);
  });

  it('names the entities each hunk touches', async () => {
    const { parts } = await partsByPath();
    expect(parts.get('web/cart.ts')!.hunks[0]!.entities).toEqual([
      { kind: 'method', name: 'Cart.total', public: true, change: 'body' },
    ]);
    expect(parts.get('app/fresh.py')!.hunks[0]!.entities).toEqual([
      { kind: 'function', name: 'fresh', public: true, change: 'added' },
    ]);
    expect(parts.get('app/reformat.py')!.hunks[0]!.entities).toEqual([
      { kind: 'function', name: 'load', public: true, change: 'declaration' },
      { kind: 'class', name: 'Store', public: true, change: 'declaration' },
      { kind: 'method', name: 'Store.__init__', public: true, change: 'declaration' },
      { kind: 'method', name: 'Store.path_for', public: true, change: 'declaration' },
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

describe('ranking in a review', () => {
  async function review(): Promise<Part[]> {
    const result = await reviewPullRequest(PR_7_URL, {
      token: 'test-token',
      fetch: fixtureFetch(pull7()).fetch,
      cacheDir,
    });
    return result.parts;
  }

  it('gives the same order and reasons for the same input', async () => {
    const ranking = (parts: Part[]): string[] =>
      parts.map((part) => `${part.rank!.importance} | ${part.name} | ${part.rank!.reason}`);
    const first = ranking(await review());
    expect(ranking(await review())).toEqual(first);
    expect(first).toMatchInlineSnapshot(`
      [
        "must review | fresh in app/fresh.py | changes the public surface: fresh; code; new code; 2 changed lines",
        "worth reviewing | Cart.total in web/cart.ts | code; changes code named in 2 other files (name-based); 2 changed lines",
        "context | test_fresh in tests/test_fresh.py | test; new code; 5 changed lines",
        "context | apply_discount in app/dedent.py | code; 2 changed lines",
        "context | scripts/deploy.rb | code; 2 changed lines",
        "context | load, Store, Store.__init__ and 1 more in app/reformat.py | formatting only, confirmed by the syntax trees; code; 17 changed lines",
        "context | Greeter, Greeter.Greet in src/Greeter.cs | formatting only, confirmed by the syntax trees; code; 10 changed lines",
      ]
    `);
  });

  it('counts references by name in the head copy, and labels the count so', async () => {
    const cart = (await review()).find((part) => part.path === 'web/cart.ts')!;
    // web/checkout.ts calls cart.total(); app/dedent.py reads order.total,
    // which a name-based count cannot tell apart.
    expect(cart.signals!.references).toEqual({ basis: 'name-based', names: ['total'], files: 2 });
  });
});
