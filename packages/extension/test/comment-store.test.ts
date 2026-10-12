import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommentStore, type SavedComments } from '../src/comment-store.js';

/** A store in its own folder, the way the extension's global storage holds one. */
function storeInTempDir(): { store: CommentStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'second-look-comment-store-'));
  return { store: new CommentStore(dir), dir };
}

const URL = 'https://github.com/example-org/example-repo/pull/42';
const OTHER_URL = 'https://github.com/example-org/example-repo/pull/43';
const HEAD = 'f00dcafe1234567890abcdef1234567890abcdef12';

/** A pending line comment and an open draft, as a review mid-writing holds them. */
function unsent(): SavedComments {
  return {
    version: 1,
    head: HEAD,
    comments: [{ kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'needs a cap', text: '    for attempt in retry.attempts():' }],
    drafts: [{ kind: 'part', path: 'src/settings.ts', body: 'Why does the timeout change?', from: 'unexplained change' }],
  };
}

/** The sha256 hex of a URL, as the store names one that parses to no GitHub pull request. */
function hashOf(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

describe('CommentStore', () => {
  it('saves and reads back one pull request’s unsent comments, in a file of its own', async () => {
    const { store, dir } = storeInTempDir();

    await store.save(URL, unsent());

    expect(await store.read(URL)).toEqual(unsent());
    expect(await store.read(OTHER_URL)).toBeUndefined();
    // One file per pull request, named for where it lives.
    expect(readdirSync(dir)).toEqual(['example-org__example-repo__pull-42.json']);
  });

  it('keeps a URL that names no GitHub pull request under a hash of itself', async () => {
    const { store, dir } = storeInTempDir();
    const url = 'https://example.com/not-a-github-pull-request';

    await store.save(url, unsent());

    expect(await store.read(url)).toEqual(unsent());
    expect(readdirSync(dir)).toEqual([`${hashOf(url)}.json`]);
  });

  it('removes the pull request’s file when nothing is left unsent', async () => {
    const { store, dir } = storeInTempDir();
    await store.save(URL, unsent());

    await store.save(URL, { version: 1, head: HEAD, comments: [], drafts: [] });

    expect(await store.read(URL)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('applies saves made in quick succession in order, so the last stands', async () => {
    const { store } = storeInTempDir();
    const first = unsent();
    const second = unsent();
    second.comments[0]!.body = 'tightened';

    await Promise.all([store.save(URL, first), store.save(URL, second)]);

    expect(await store.read(URL)).toEqual(second);
  });

  it('reads nothing for a missing file, a corrupt one, or one it does not trust', async () => {
    const { store, dir } = storeInTempDir();
    const file = join(dir, 'example-org__example-repo__pull-42.json');

    expect(await store.read(URL)).toBeUndefined();

    writeFileSync(file, 'not json at all', 'utf8');
    expect(await store.read(URL)).toBeUndefined();

    writeFileSync(file, JSON.stringify({ version: 2, head: HEAD, comments: [], drafts: [] }), 'utf8');
    expect(await store.read(URL)).toBeUndefined();

    // A record that names no commit is left out rather than trusted.
    writeFileSync(file, JSON.stringify({ version: 1, comments: [], drafts: [] }), 'utf8');
    expect(await store.read(URL)).toBeUndefined();

    // A comment that points nowhere recognisable is left out rather than trusted.
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        head: HEAD,
        comments: [{ kind: 'line', path: 'src/retry.py', side: 'middle', line: 5, body: 'x' }],
        drafts: [],
      }),
      'utf8',
    );
    expect(await store.read(URL)).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toContain('middle'); // the file itself is untouched
  });
});
