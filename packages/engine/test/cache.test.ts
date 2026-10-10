import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCacheDir, ensureCopy, ensureProjectCopy, projectCopyDir, pullRequestCacheDir, removeCopy } from '../src/cache.js';
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

describe('ensureProjectCopy', () => {
  /** A head copy made by hand, holding a link no archive would carry, to prove none is copied. */
  function handMadeHead(): string {
    const head = join(cacheDir, 'hand-made-head');
    mkdirSync(join(head, 'src'), { recursive: true });
    writeFileSync(join(head, 'src', 'Program.cs'), 'class Program {}\n');
    symlinkSync('/etc/hosts', join(head, 'src', 'hosts'));
    return head;
  }

  it('copies regular files and folders only, never a link, and leaves no partial folder behind', async () => {
    const project = await ensureProjectCopy(cacheDir, REF, { commit: COMMIT, path: handMadeHead(), reused: false });

    expect(project).toEqual({ commit: COMMIT, path: projectCopyDir(cacheDir, REF, COMMIT), reused: false });
    expect(readdirSync(join(project.path, 'src'))).toEqual(['Program.cs']);
    expect(readFileSync(join(project.path, 'src', 'Program.cs'), 'utf8')).toBe('class Program {}\n');
    expect(statSync(join(project.path, 'src', 'Program.cs')).mode & 0o777).toBe(0o644);
    expect(readdirSync(join(pullRequestCacheDir(cacheDir, REF), 'project'))).toEqual([COMMIT]);
  });

  it('refuses anything but a full commit hash, writing nothing', async () => {
    await expect(ensureProjectCopy(cacheDir, REF, { commit: '../master', path: handMadeHead(), reused: false })).rejects.toThrow(/not a full commit hash/);
    expect(existsSync(pullRequestCacheDir(cacheDir, REF))).toBe(false);
  });
});
