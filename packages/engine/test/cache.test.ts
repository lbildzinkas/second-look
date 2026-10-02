import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCacheDir, ensureCopy, pullRequestCacheDir, removeCopy } from '../src/cache.js';
import { githubTarball, temporaryCacheDir } from './helpers.js';

const REF = { owner: 'example-org', repo: 'example-repo', number: 7 };
const COMMIT = 'a'.repeat(40);

async function* once(buffer: Buffer): AsyncIterable<Uint8Array> {
  yield buffer;
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

describe('defaultCacheDir', () => {
  it('prefers SECOND_LOOK_CACHE_DIR', () => {
    expect(defaultCacheDir({ SECOND_LOOK_CACHE_DIR: '/tmp/mine' }, 'linux', '/home/r')).toBe(
      '/tmp/mine',
    );
  });

  it('uses each platform’s per-user cache folder', () => {
    expect(defaultCacheDir({}, 'linux', '/home/r')).toBe(join('/home/r', '.cache', 'second-look'));
    expect(defaultCacheDir({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/r')).toBe(
      join('/xdg', 'second-look'),
    );
    expect(defaultCacheDir({}, 'darwin', '/Users/r')).toBe(
      join('/Users/r', 'Library', 'Caches', 'second-look'),
    );
    expect(defaultCacheDir({ LOCALAPPDATA: 'C:\\Local' }, 'win32', 'C:\\Users\\r')).toBe(
      join('C:\\Local', 'second-look', 'cache'),
    );
  });
});

describe('pullRequestCacheDir', () => {
  it('keeps one folder per pull request', () => {
    expect(pullRequestCacheDir('/cache', REF)).toBe(
      join('/cache', 'github.com', 'example-org', 'example-repo', 'pull-7'),
    );
  });

  it('refuses names that would steer the path', () => {
    expect(() => pullRequestCacheDir('/cache', { ...REF, owner: '..' })).toThrow(
      /not a GitHub owner/,
    );
    expect(() => pullRequestCacheDir('/cache', { ...REF, repo: 'a\\b' })).toThrow(
      /not a GitHub owner/,
    );
  });
});

describe('ensureCopy', () => {
  it('refuses anything but a full commit hash', async () => {
    await expect(
      ensureCopy({
        cacheDir,
        ref: REF,
        commit: '../master',
        download: () => Promise.reject(new Error('no')),
      }),
    ).rejects.toThrow(/not a full commit hash/);
  });

  it('leaves nothing behind when the download fails', async () => {
    await expect(
      ensureCopy({
        cacheDir,
        ref: REF,
        commit: COMMIT,
        download: async () => once(Buffer.from('not a gzip stream')),
      }),
    ).rejects.toThrow();
    expect(readdirSync(pullRequestCacheDir(cacheDir, REF))).toEqual([]);
  });

  it('settles two runs racing for the same commit on one copy', async () => {
    const download = async (): Promise<AsyncIterable<Uint8Array>> =>
      once(githubTarball({ 'a.txt': 'a\n' }, COMMIT));
    const [first, second] = await Promise.all([
      ensureCopy({ cacheDir, ref: REF, commit: COMMIT, download }),
      ensureCopy({ cacheDir, ref: REF, commit: COMMIT, download }),
    ]);
    expect(first.path).toBe(second.path);
    expect(existsSync(join(first.path, 'a.txt'))).toBe(true);
    expect(readdirSync(pullRequestCacheDir(cacheDir, REF))).toEqual([COMMIT]);
  });
});
