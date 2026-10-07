import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pullRequestCacheDir, removeCopy } from '../src/cache.js';
import { parseDiff } from '../src/diff.js';
import { GitHubClient, type PullRequestRef } from '../src/github.js';
import { LAST_LOOK_FILE, changePieces, changedSinceLastLook, lookSinceLastLook, readLooks, recordLook } from '../src/last-look.js';
import type { Part, PullRequestSummary, SinceLastLook } from '../src/protocol.js';
import { temporaryCacheDir } from './helpers.js';

const REF: PullRequestRef = { owner: 'example-org', repo: 'example-repo', number: 42 };
const API = 'https://api.github.com/repos/example-org/example-repo';
const THEN = new Date('2026-10-01T09:00:00Z');
const NOW = new Date('2026-10-07T09:00:00Z');

/** Forty numbered lines, so edits far apart land in separate hunks. */
const LINES = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);

/**
 * A local git repository standing in for the pull request's repository:
 * the tests build the pushes, rebases and force-pushes with real git, and
 * the fake GitHub below serves its compare diffs from it. Nothing leaves
 * the machine, and no global git configuration is read.
 */
class Repository {
  readonly dir = mkdtempSync(join(tmpdir(), 'second-look-git-'));

  constructor() {
    this.git('init', '--quiet', '--initial-branch=master');
  }

  git(...args: string[]): string {
    return execFileSync(
      'git',
      ['-c', 'user.name=Reviewer', '-c', 'user.email=reviewer@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
      { cwd: this.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' } },
    );
  }

  /** Writes the files, commits them and answers with the new commit. */
  commit(files: Record<string, string>, message: string): string {
    for (const [path, content] of Object.entries(files)) writeFileSync(join(this.dir, path), content);
    this.git('add', '--all');
    this.git('commit', '--quiet', '--no-verify', '-m', message);
    return this.sha('HEAD');
  }

  sha(rev: string): string {
    return this.git('rev-parse', rev).trim();
  }

  /** The diff GitHub's compare endpoint serves for `base...head`; null when a commit is missing. */
  compare(base: string, head: string): string | null {
    try {
      this.git('cat-file', '-e', `${base}^{commit}`);
      this.git('cat-file', '-e', `${head}^{commit}`);
    } catch {
      return null;
    }
    return this.git('diff', `${base}...${head}`);
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The file with the given numbered lines replaced. */
function edited(edits: Record<number, string>): string {
  return `${LINES.map((line, index) => edits[index + 1] ?? line).join('\n')}\n`;
}

/**
 * A fetch that plays GitHub for the repository: the compare endpoint's
 * diff from local git, 404 for a commit it does not have, the signed-in
 * reviewer, and their reviews of the pull request.
 */
function gitHubOf(repository: Repository, reviews: unknown[] = []): typeof fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const compare = new RegExp(`^${API}/compare/([0-9a-f]+)\\.\\.\\.([0-9a-f]+)$`).exec(url);
    if (compare) {
      const diff = repository.compare(compare[1]!, compare[2]!);
      if (diff === null) return Response.json({ message: 'Not Found' }, { status: 404 });
      return new Response(diff, { status: 200, headers: { 'content-type': 'application/vnd.github.v3.diff' } });
    }
    if (url === 'https://api.github.com/user') return Response.json({ login: 'reviewer' });
    if (url === `${API}/pulls/42/reviews?per_page=100`) return Response.json(reviews);
    throw new Error(`unexpected request to ${url}: tests run against the local repository only`);
  };
}

let cacheDir: string;
let repository: Repository;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
  repository = new Repository();
});

afterEach(async () => {
  await removeCopy(cacheDir);
  repository.remove();
});

/** The pull request as GitHub would show it with the branch at its current commit, against master. */
function pullRequestNow(): PullRequestSummary {
  return {
    url: 'https://github.com/example-org/example-repo/pull/42',
    number: 42,
    title: 'Edit the lines',
    author: 'author',
    description: '',
    base: 'master',
    head: 'feature',
    baseCommit: repository.sha('master'),
    headSha: repository.sha('feature'),
  };
}

/** Opens the review now: compares with the last look and records this one. */
async function openReview(reviews: unknown[] = []): Promise<{ since: SinceLastLook | undefined; parts: Part[] }> {
  const pullRequest = pullRequestNow();
  const diff = repository.compare(pullRequest.baseCommit, pullRequest.headSha)!;
  const client = new GitHubClient({ token: 'test-token', fetch: gitHubOf(repository, reviews) });
  const since = await lookSinceLastLook({ client, cacheDir, ref: REF, pullRequest, diff, now: NOW });
  // One part per hunk, so each edit shows on its own.
  const parts = parseDiff(diff).files.flatMap((file) => (file.hunks.length === 0 ? [file] : file.hunks.map((hunk) => ({ ...file, hunks: [hunk] }))));
  return { since, parts };
}

/** The changed parts, each by its file and its first new line. */
function flagged(parts: Part[], since: SinceLastLook): string[] {
  return parts.filter((part) => changedSinceLastLook(part, since)).map((part) => `${part.path}:${part.hunks[0]?.newStart ?? 0}`);
}

/** master with two files; feature edits app.txt at lines 5 and 30, in two hunks. */
function startPullRequest(): void {
  repository.commit({ 'app.txt': edited({}), 'util.txt': edited({}) }, 'start');
  repository.git('checkout', '--quiet', '-b', 'feature');
  repository.commit({ 'app.txt': edited({ 5: 'five', 30: 'thirty' }) }, 'edit app');
}

/** A look recorded at the feature branch's current commit, as if the reviewer opened the review then. */
async function lookNow(): Promise<string> {
  const commit = repository.sha('feature');
  await recordLook(cacheDir, REF, { commit, at: THEN.toISOString() });
  return commit;
}

describe('since your last look', () => {
  it('is nothing on the first look, and records it', async () => {
    startPullRequest();
    const { since } = await openReview();
    expect(since).toBeUndefined();
    expect((await readLooks(cacheDir, REF))?.last).toEqual({ commit: repository.sha('feature'), at: NOW.toISOString() });
  });

  it('flags only the part a plain push changed', async () => {
    startPullRequest();
    const looked = await lookNow();
    repository.commit({ 'util.txt': edited({ 12: 'twelve' }) }, 'edit util');
    const { since, parts } = await openReview();
    expect(since).toMatchObject({ commit: looked, from: 'local record', at: THEN.toISOString(), outcome: 'compared' });
    expect(flagged(parts, since!)).toEqual(['util.txt:9']);
  });

  it('flags nothing after a rebase onto a newer master, whatever upstream changed', async () => {
    startPullRequest();
    const looked = await lookNow();
    repository.git('checkout', '--quiet', 'master');
    // Upstream edits a line inside the context of the first hunk, edits
    // the other file and adds one: none of it is the pull request's.
    repository.commit({ 'app.txt': edited({ 8: 'eight upstream' }), 'util.txt': edited({ 20: 'upstream' }), 'new.txt': 'upstream\n' }, 'upstream');
    repository.git('checkout', '--quiet', 'feature');
    repository.git('rebase', '--quiet', 'master');
    expect(repository.sha('feature')).not.toBe(looked);
    const { since, parts } = await openReview();
    expect(since).toMatchObject({ commit: looked, outcome: 'compared', changed: [] });
    expect(flagged(parts, since!)).toEqual([]);
  });

  it('flags only the edited part after a force-push that rebased and edited', async () => {
    startPullRequest();
    const looked = await lookNow();
    repository.git('checkout', '--quiet', 'master');
    repository.commit({ 'util.txt': edited({ 20: 'upstream' }) }, 'upstream');
    repository.git('checkout', '--quiet', 'feature');
    repository.git('rebase', '--quiet', 'master');
    writeFileSync(join(repository.dir, 'app.txt'), edited({ 5: 'five', 30: 'thirty, edited' }));
    repository.git('commit', '--quiet', '--no-verify', '--all', '--amend', '--no-edit');
    const { since, parts } = await openReview();
    expect(since).toMatchObject({ commit: looked, outcome: 'compared' });
    expect(flagged(parts, since!)).toEqual(['app.txt:27']);
  });

  it('says the old commit is gone and counts every part as changed', async () => {
    startPullRequest();
    const looked = await lookNow();
    writeFileSync(join(repository.dir, 'app.txt'), edited({ 5: 'five', 30: 'thirty, edited' }));
    repository.git('commit', '--quiet', '--no-verify', '--all', '--amend', '--no-edit');
    // The force-pushed commit is collected: nothing reaches it any more.
    repository.git('reflog', 'expire', '--expire=now', '--all');
    repository.git('gc', '--quiet', '--prune=now');
    expect(repository.compare(repository.sha('master'), looked)).toBeNull();
    const { since, parts } = await openReview();
    expect(since).toEqual({ commit: looked, from: 'local record', at: THEN.toISOString(), outcome: 'commit gone', changed: [] });
    expect(flagged(parts, since!)).toEqual(['app.txt:2', 'app.txt:27']);
  });

  it("falls back to the commit of the reviewer's last submitted GitHub review", async () => {
    startPullRequest();
    const reviewedAt = repository.sha('feature');
    repository.commit({ 'util.txt': edited({ 12: 'twelve' }) }, 'edit util');
    const someoneElse = repository.sha('feature');
    const reviews = [
      { user: { login: 'reviewer' }, state: 'COMMENTED', commit_id: reviewedAt, submitted_at: '2026-10-02T10:00:00Z' },
      { user: { login: 'someone-else' }, state: 'APPROVED', commit_id: someoneElse, submitted_at: '2026-10-03T10:00:00Z' },
      { user: { login: 'reviewer' }, state: 'PENDING', commit_id: someoneElse },
    ];
    const { since, parts } = await openReview(reviews);
    expect(since).toMatchObject({ commit: reviewedAt, from: 'github review', at: '2026-10-02T10:00:00Z', outcome: 'compared' });
    expect(flagged(parts, since!)).toEqual(['util.txt:9']);
  });

  it('keeps comparing with the look before when the review opens again at the same commit', async () => {
    startPullRequest();
    const looked = await lookNow();
    repository.commit({ 'util.txt': edited({ 12: 'twelve' }) }, 'edit util');
    await openReview();
    const { since, parts } = await openReview();
    expect(since).toMatchObject({ commit: looked, from: 'local record' });
    expect(flagged(parts, since!)).toEqual(['util.txt:9']);
  });

  it('reads a record that is not one as no look', async () => {
    startPullRequest();
    await lookNow();
    await writeFile(join(pullRequestCacheDir(cacheDir, REF), LAST_LOOK_FILE), '{ not json', 'utf8');
    expect(await readLooks(cacheDir, REF)).toBeNull();
    const { since } = await openReview();
    expect(since).toBeUndefined();
    const stored = JSON.parse(await readFile(join(pullRequestCacheDir(cacheDir, REF), LAST_LOOK_FILE), 'utf8'));
    expect(stored.last.commit).toBe(repository.sha('feature'));
  });

  it('hashes a hunk by its changed lines alone, so new context reads the same', () => {
    const hunk = (context: string): Part =>
      parseDiff(`diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 ${context}
-old
+new
`).files[0]!;
    expect(changePieces(hunk('before'))).toEqual(changePieces(hunk('upstream changed this')));
  });
});
